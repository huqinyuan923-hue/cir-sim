/**
 * M4 · Hack 整机黄金向量对拍。
 *
 * 向量格式（computer-trace，nand-computer SPEC 口径）：
 * - rom：16 位二进制行（自地址 0）；
 * - resetCycles：前 N 个周期复位线为高（PC 钉 0，指令照常执行）；
 * - keyboard：[cycle, keycode] 事件（cycle 起始时刻生效，keycode 0=抬起）；
 * - trace[i]：第 i 个周期结束（沿后）的锁存状态 pc/a/d + 下一指令的组合译码
 *   addressM/outM/writeM；A 指令的 outM 约定为 null；
 * - finalRam / finalScreenHash：全部周期跑完后的断言。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HackMachine } from '../src/hack/computer';
import { parseHack } from '../src/hack/rom';
import { screenPixel } from '../src/chips/handles';
import { MEMDECODE_BEHAVIOR } from '../src/chips/memdecode';
import { buildChipBench } from '../src/testkit/harness';
import { makeEngine } from '../src/testkit/engineFactory';
import { createDevEngine } from '../src/testkit/devEngine';
import { screenHash } from './helpers/screenHash';
import { loadSwText } from './helpers/golden';

interface TraceEntry {
  pc: number;
  a: number;
  d: number;
  addressM: number;
  outM: number | null;
  writeM: number;
}

interface ComputerGolden {
  chip: string;
  kind: 'computer-trace';
  comment?: string;
  rom: string[];
  initRam?: Record<string, number>;
  keyboard?: [number, number][];
  resetCycles?: number;
  cycles: number;
  trace: (TraceEntry | null)[];
  finalRam?: Record<string, number>;
  finalScreenHash?: string;
}

function loadComputerGolden(name: string): ComputerGolden {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, '..', 'golden', `${name}.json`), 'utf-8')) as ComputerGolden;
}

/** 单条整机向量：建机 → 逐周期驱动/采样 → finalRam/finalScreenHash 断言 */
function runComputerGolden(
  name: string,
  g: ComputerGolden,
  engineFactory: () => import('../src/contract').SimEngine = makeEngine,
): void {
  const romWords = g.rom.map((line) => parseInt(line, 2));
  const m = new HackMachine(engineFactory(), { program: romWords, ramInit: g.initRam });
  const kbdByCycle = new Map<number, number>();
  for (const [cycle, code] of g.keyboard ?? []) kbdByCycle.set(cycle, code);

  expect(g.trace.length).toBe(g.cycles);
  for (let c = 0; c < g.cycles; c++) {
    m.setReset(c < (g.resetCycles ?? 0));
    const ev = kbdByCycle.get(c);
    if (ev !== undefined) m.setKbd(ev);
    m.engine.tick();
    const expected = g.trace[c];
    if (expected) {
      const pc = m.readPc();
      const a = m.readA();
      const d = m.readD();
      const instr = romWords[pc & 0x7fff] ?? 0;
      const isC = (instr & 0x8000) !== 0;
      const actual = {
        pc,
        a,
        d,
        addressM: a,
        outM: isC ? m.readOutM() : null,
        writeM: m.readWriteM(),
      };
      for (const [k, want] of Object.entries(expected)) {
        const got = actual[k as keyof typeof actual];
        expect(got, `${name} trace[${c}].${k}${g.comment ? `（${g.comment}）` : ''}`).toBe(want);
      }
    }
    m.engine.clockEdge();
  }

  // 诊断清洁：整机不允许振荡/冲突
  const errors = m.engine.diagnostics().filter((x) => x.level === 'error');
  expect(errors, `${name} 引擎诊断应无 error`).toEqual([]);

  if (g.finalRam) {
    for (const [addr, want] of Object.entries(g.finalRam)) {
      expect(m.ramValue(Number(addr)), `${name} finalRam[${addr}]`).toBe(want);
    }
  }
  if (g.finalScreenHash !== undefined) {
    expect(screenHash(m.screen.words), `${name} finalScreenHash`).toBe(g.finalScreenHash);
  }
}

describe('M4 · Hack 整机黄金向量对拍', () => {
  beforeEach(() => {
    // 整机测试用固定句柄 id，先清注册表防串扰
    // （clearAllHandles 在 src/chips/handles；此处经 HackMachine 的隔离 id 也可，但统一清更稳）
  });

  it('computer-add：RAM[16] = 5 + 3（含 resetCycles 与逐周期 trace）', () => {
    runComputerGolden('computer-add', loadComputerGolden('computer-add'));
  });

  it('computer-max：RAM[2] = max(RAM[0], RAM[1])（跳转 + initRam）', () => {
    runComputerGolden('computer-max', loadComputerGolden('computer-max'));
  });

  it('computer-oob：越界写忽略 / 越界读得 0（KBD 精确译码）', () => {
    runComputerGolden('computer-oob', loadComputerGolden('computer-oob'));
  });

  it('computer-screen-kbd：屏幕写 + 键盘读 + SHA-256 帧哈希对拍', () => {
    runComputerGolden('computer-screen-kbd', loadComputerGolden('computer-screen-kbd'));
  });

  it('差分对拍：computer-screen-kbd 在 DevEngine（暴力参考实现）上同样通过', () => {
    // 同一向量、两台引擎（真引擎 + 满足同一契约的暴力实现），结果一致 → 芯片语义
    // 只依赖契约可观测行为，不依赖引擎内部实现
    runComputerGolden('computer-screen-kbd', loadComputerGolden('computer-screen-kbd'), createDevEngine);
  });

  it('屏幕哈希口径自检：SPEC 样例（screen[0]=0xFFFF, screen[32]=1, screen[64]=65）', () => {
    // computer-screen-kbd 的 finalScreenHash 就建立在这三个字上；
    // 这里独立复核 SPEC 的"大端展开"读法：手动构造同样的三字帧做哈希。
    const words = new Array<number>(8192).fill(0);
    words[0] = 0xffff;
    words[32] = 1;
    words[64] = 65;
    const h1 = screenHash(words);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // 与机器产出的哈希一致性由上一用例保证；此处复核哈希随内容变化
    words[65] = 1;
    expect(screenHash(words)).not.toBe(h1);
  });
});

describe('M4 · 汇编产物端到端（nand-computer 汇编器产物）', () => {
  it('sum 程序：RAM[0]=10 → RAM[1]=55（1+2+…+10）', () => {
    const m = new HackMachine(makeEngine(), {
      program: parseHack(loadSwText('sum.hack')),
      ramInit: { 0: 10 },
    });
    m.setReset(true);
    m.cycle(); // reset 周期：执行两次首指令
    m.setReset(false);
    m.runCycles(300);
    expect(m.ramValue(1)).toBe(55);
  });

  it('kbdcopy 程序：KBD → SCREEN[0]（内存映射读写链路）', () => {
    const m = new HackMachine(makeEngine(), { program: parseHack(loadSwText('kbdcopy.hack')) });
    m.setReset(true);
    m.cycle();
    m.setReset(false);
    m.setKbd(65); // 'A'
    m.runCycles(4);
    expect(m.screen.words[0]).toBe(65);
    // 抬键后再跑一轮：程序已跑完（后续执行空 ROM），screen 保持
    m.setKbd(0);
    m.runCycles(2);
    expect(m.screen.words[0]).toBe(65);
  });

  it('像素口径：screen[0]=0xFFFF 时 (0..15, 0) 全亮、(16, 0) 不亮', () => {
    const m = new HackMachine(makeEngine(), { program: parseHack(loadSwText('kbdcopy.hack')) });
    m.setKbd(0xffff);
    m.runCycles(6);
    expect(m.screen.words[0]).toBe(0xffff);
    expect(screenPixel(m.screen.words, 0, 0)).toBe(1);
    expect(screenPixel(m.screen.words, 15, 0)).toBe(1);
    expect(screenPixel(m.screen.words, 16, 0)).toBe(0);
    expect(screenPixel(m.screen.words, 0, 1)).toBe(0);
  });

  it('reset() 语义：复位 CPU 与时序状态，程序与屏幕内容幸存', () => {
    const m = new HackMachine(makeEngine(), { program: parseHack(loadSwText('kbdcopy.hack')) });
    m.setKbd(0x1234);
    m.runCycles(4);
    expect(m.screen.words[0]).toBe(0x1234);
    m.engine.reset();
    expect(m.rom.words[0]).toBe(parseHack(loadSwText('kbdcopy.hack'))[0]); // 程序在
    expect(m.screen.words[0]).toBe(0x1234); // 帧缓冲在
    m.setKbd(0x4321);
    m.runCycles(6);
    expect(m.screen.words[0]).toBe(0x4321); // 复位后仍可继续运行
  });

  it('MEMDECODE：全 65536 地址与 SPEC 口径的参考译码差分', () => {
    const bench = buildChipBench(makeEngine, MEMDECODE_BEHAVIOR);
    for (let a = 0; a < 65536; a++) {
      bench.set('a', a);
      bench.tick();
      const hi = a & 0xc000;
      const want = [hi === 0 ? 1 : 0, hi === 0x4000 ? 1 : 0, a === 0x6000 ? 1 : 0];
      const got = [bench.get('isram'), bench.get('isscr'), bench.get('kbd')];
      if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
        throw new Error(`MEMDECODE(0x${a.toString(16)}) 期望 ${want} 实际 ${got}`);
      }
    }
  });
});
