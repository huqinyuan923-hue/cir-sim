/**
 * Hack 计算机总装：CPU 子电路模板 + ROM32K + RAM16K + SCREEN + KEYBOARD
 * 按内存映射连线，经 expand() 扁平化后喂 engine.load()。
 *
 * 内存映射（SPEC 冻结口径）：
 *   0x0000–0x3FFF  RAM16K   （A14=0）
 *   0x4000–0x5FFF  SCREEN   （A14=1, A13=0）
 *   0x6000         KBD      （A14=1, A13=1 且 A12..A0 全 0 —— 精确匹配）
 *   越界（0x6001–0x7FFF）读得 0、写忽略 —— KBD 精确译码 + 双 MUX 树实现。
 *
 * 外部输入按契约建模为 PIN_IN（engine.setInput 唯一外部入口，决策 D4）：
 *   reset：复位线（接 PC.reset）
 *   kbd：键盘键码（16 位，画布/测试经 setInput 注入）
 *
 * 可观察信号以 PIN_OUT 暴露：pc / a / d / outM / writeM / instr（对拍与调试用）。
 */

import type { Netlist, PortRef, SimEngine } from '../contract';
import { expand } from '../expand/expand';
import { NetlistBuilder, port } from '../expand/builder';
import { chipLibrary } from '../chips/registerAll';
import { adoptKeyboard, adoptRam16K, adoptRom, adoptScreen } from '../chips/handles';
import type { RamState, RomState, ScreenState } from '../chips/handles';
import { CPU_KIND, buildCpuTemplate } from './cpu';
import { parseHack, ROM_SIZE } from './rom';

/** 根层组件/引脚 id（HackMachine 依据这些 id 驱动与观察） */
export const HACK_IDS = {
  resetPin: 'in_reset',
  kbdPin: 'in_kbd',
  rom: 'rom',
  ram: 'ram',
  screen: 'screen',
  obsPc: 'obs_pc',
  obsA: 'obs_a',
  obsD: 'obs_d',
  obsOutM: 'obs_outm',
  obsWriteM: 'obs_writem',
  obsInstr: 'obs_instr',
} as const;

/** 构建整机网表（已扁平化：CPU 模板展开为原生芯片混合网表） */
export function buildComputerNetlist(ids: {
  romId: string;
  ramId: string;
  screenId: string;
}): Netlist {
  const b = new NetlistBuilder();
  const templates: Record<string, Netlist> = { [CPU_KIND]: buildCpuTemplate() };

  // 对外输入
  const reset = b.pinIn(HACK_IDS.resetPin, 'reset');
  const kbd = b.pinIn(HACK_IDS.kbdPin, 'kbd', 16);

  // CPU（模板实例）与 ROM
  const cpu = b.add('cpu', CPU_KIND);
  const rom = b.add(HACK_IDS.rom, 'ROM32K', { id: ids.romId });
  b.connect(port(cpu, 'pc'), port(rom, 'address'));
  b.connect(port(rom, 'out'), port(cpu, 'instr'));
  b.connect(reset, port(cpu, 'reset'));

  // 地址译码（MEMDECODE 库芯片：isram/isscr/kbd 三选，越界精确译码内置）
  const aOut = port(cpu, 'a');
  const dec = b.add('memdec', 'MEMDECODE');
  b.connect(aOut, port(dec, 'a'));
  const isRAM = port(dec, 'isram');
  const isScr = port(dec, 'isscr');
  const kbdExact = port(dec, 'kbd');
  const s14 = b.add('sa14', 'SPLIT', { index: 14 });
  b.connect(aOut, port(s14, 'bus'));
  const a14 = port(s14, 'bit');
  const s13 = b.add('sa13', 'SPLIT', { index: 13 });
  b.connect(aOut, port(s13, 'bus'));
  const a13 = port(s13, 'bit');

  // 写使能
  const wm = port(cpu, 'writeM');
  const loadRam = port(b.add('ldram', 'AND'), 'y');
  b.connect(wm, { componentId: loadRam.componentId, port: 'a' });
  b.connect(isRAM, { componentId: loadRam.componentId, port: 'b' });
  const loadScr = port(b.add('ldscr', 'AND'), 'y');
  b.connect(wm, { componentId: loadScr.componentId, port: 'a' });
  b.connect(isScr, { componentId: loadScr.componentId, port: 'b' });

  // 存储
  const outM = port(cpu, 'outM');
  const ram = b.add(HACK_IDS.ram, 'RAM16K', { id: ids.ramId });
  b.connect(outM, port(ram, 'in'));
  b.connect(loadRam, port(ram, 'load'));
  b.connect(aOut, port(ram, 'address'));
  const screen = b.add(HACK_IDS.screen, 'SCREEN', { id: ids.screenId });
  b.connect(outM, port(screen, 'in'));
  b.connect(loadScr, port(screen, 'load'));
  b.connect(aOut, port(screen, 'address'));

  // 读出 MUX 树：A14=0→RAM；A14=1: A13=0→SCREEN, A13=1→KBD（越界精确译码后为 0）
  const zero = port(b.add('zero16', 'CONST', { value: 0 }), 'y');
  const kbdMux = b.add('mux_kbd', 'MUX16');
  b.connect(zero, port(kbdMux, 'a'));
  b.connect(kbd, port(kbdMux, 'b'));
  b.connect(kbdExact, port(kbdMux, 'sel'));
  const m1 = b.add('mux_rs', 'MUX16');
  b.connect(port(ram, 'out'), port(m1, 'a'));
  b.connect(port(screen, 'out'), port(m1, 'b'));
  b.connect(a14, port(m1, 'sel'));
  const memOut = b.add('mux_mem', 'MUX16');
  b.connect(port(m1, 'out'), port(memOut, 'a'));
  b.connect(port(kbdMux, 'out'), port(memOut, 'b'));
  b.connect(a13, port(memOut, 'sel'));
  b.connect(port(memOut, 'out'), port(cpu, 'inM'));

  // 观察引脚
  const obs = (id: string, from: PortRef): void => {
    b.connect(from, b.pinOut(id, id.replace('obs_', '')));
  };
  obs(HACK_IDS.obsPc, port(cpu, 'pc'));
  obs(HACK_IDS.obsA, aOut);
  obs(HACK_IDS.obsD, port(cpu, 'd'));
  obs(HACK_IDS.obsOutM, outM);
  obs(HACK_IDS.obsWriteM, wm);
  obs(HACK_IDS.obsInstr, port(rom, 'out'));

  // CPU 模板展开 → 扁平网表
  return expand(b.build(), templates);
}

// ── 整机控制器 ──────────────────────────────────────────────────────────────

export interface HackMachineOptions {
  /** 引擎工厂（默认 testkit 引擎；M5 集成后可传真引擎做对拍） */
  makeEngine?: () => SimEngine;
  /** 程序（16 位字数组或 .hack 文本） */
  program?: number[] | string;
  /** RAM 初始化（如 computer-max 的 initRam） */
  ramInit?: Record<number, number>;
  /** 句柄 id（多机实例隔离用） */
  handleIds?: { rom?: string; ram?: string; screen?: string };
  /**
   * 行为包装钩子（性能基准用）：注册芯片库时逐个过一遍，
   * 可包一层计数代理统计 evaluate/onClockEdge 调用数（"门事件"口径）。
   */
  behaviorWrapper?: (kind: string, behavior: import('../contract').ChipBehavior) => import('../contract').ChipBehavior;
}

/** Hack 计算机控制器：网表装配 + 句柄 + 周期驱动 + 观测 */
export class HackMachine {
  readonly engine: SimEngine;
  /** 展开后的扁平网表（画布可直接加载同一份） */
  readonly netlist: Netlist;
  readonly rom: RomState;
  readonly ram: RamState;
  readonly screen: ScreenState;
  readonly handleIds: { rom: string; ram: string; screen: string };

  private readonly resetRef: PortRef;
  private readonly kbdRef: PortRef;

  constructor(engine: SimEngine, opts: HackMachineOptions = {}) {
    this.engine = engine;
    const lib = chipLibrary();
    for (const [kind, behavior] of Object.entries(lib)) {
      engine.registerBehavior(kind, opts.behaviorWrapper ? opts.behaviorWrapper(kind, behavior) : behavior);
    }
    const ids = {
      rom: opts.handleIds?.rom ?? 'hack-rom',
      ram: opts.handleIds?.ram ?? 'hack-ram',
      screen: opts.handleIds?.screen ?? 'hack-screen',
    };
    this.handleIds = ids;
    // 先认领句柄（load 前），程序/种子随即写入，engine.load 的 initState 会认领同一对象
    this.rom = adoptRom({ id: ids.rom });
    this.ram = adoptRam16K({ id: ids.ram });
    this.screen = adoptScreen({ id: ids.screen });
    adoptKeyboard({ id: 'hack-kbd' }); // 键盘外设句柄（机器内实际由 kbd PIN_IN 驱动）
    if (typeof opts.program === 'string') opts.program = parseHack(opts.program);
    if (opts.program) {
      if (opts.program.length > ROM_SIZE) throw new Error(`程序超 ROM 容量（${ROM_SIZE} 字）`);
      this.rom.words.fill(0);
      this.rom.words.splice(0, opts.program.length, ...opts.program);
    }
    if (opts.ramInit) {
      this.ram.mem.fill(0);
      for (const [k, v0] of Object.entries(opts.ramInit)) {
        this.ram.mem[Number(k)] = v0 & 0xffff;
      }
    } else {
      this.ram.mem.fill(0);
    }
    this.screen.words.fill(0);

    this.netlist = buildComputerNetlist({ romId: ids.rom, ramId: ids.ram, screenId: ids.screen });
    engine.load(this.netlist);
    this.resetRef = { componentId: HACK_IDS.resetPin, port: 'y' };
    this.kbdRef = { componentId: HACK_IDS.kbdPin, port: 'y' };
  }

  /** 复位线（resetCycles 语义：置 1 期间 PC 钉在 0） */
  setReset(on: boolean | 0 | 1): void {
    this.engine.setInput(this.resetRef, on ? 1 : 0);
  }

  /** 键盘注入（0 = 抬键） */
  setKbd(keyCode: number): void {
    this.engine.setInput(this.kbdRef, keyCode & 0xffff);
  }

  /** 一个完整机器周期：组合收敛 → 上升沿 → 组合收敛 */
  cycle(): void {
    this.engine.tick();
    this.engine.clockEdge();
    this.engine.tick();
  }

  /** 连跑 n 个周期（返回实际耗时 ms，供基准） */
  runCycles(n: number): number {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) this.cycle();
    return performance.now() - t0;
  }

  // 观测
  readPc(): number {
    return this.engine.read({ componentId: HACK_IDS.obsPc, port: 'a' });
  }
  readA(): number {
    return this.engine.read({ componentId: HACK_IDS.obsA, port: 'a' });
  }
  readD(): number {
    return this.engine.read({ componentId: HACK_IDS.obsD, port: 'a' });
  }
  readOutM(): number {
    return this.engine.read({ componentId: HACK_IDS.obsOutM, port: 'a' });
  }
  readWriteM(): number {
    return this.engine.read({ componentId: HACK_IDS.obsWriteM, port: 'a' });
  }
  readInstr(): number {
    return this.engine.read({ componentId: HACK_IDS.obsInstr, port: 'a' });
  }
  /** RAM 快照（finalRam 对拍用） */
  ramValue(addr: number): number {
    return this.ram.mem[addr] ?? 0;
  }
}
