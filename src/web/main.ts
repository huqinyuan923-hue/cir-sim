/**
 * 示例页主入口（esbuild 打包目标）。
 *
 * 布局：Hack 屏幕（512×256 帧缓冲）+ 电路画布（cir-canvas 渲染整机网表）
 * + demo 菜单 + 运行控制 + 机器状态。
 *
 * 键盘：页面上按下即注入 kbd PIN_IN（SPEC 键码：可打印=码点，Backspace=8、
 * Enter=13、Esc=27、方向键 37-40；抬起写 0）。
 *
 * 集成要点：全页共用一个引擎实例（demo 切换 = HackMachine 重新 load 同一引擎，
 * 句柄认领模式保证 ROM/屏幕内容正确重建）；电路画布的 Controller 在文档变更时
 * 自动 engine.load + tick，与整机控制器天然协同。
 */

import { createEngine } from '../engine/createEngine';
import { HackMachine } from '../hack/computer';
import { ScreenView, hackKeyCode } from './screenView';
import { registerChipShapes } from './chipShapes';
import { NetlistDoc } from '../canvas/state/doc';
import { SimController } from '../canvas/sim/SimController';
import { CanvasView } from '../canvas/ui/CanvasView';
import { Controller } from '../canvas/ui/Controller';
import movblkHack from '../hack/programs/movblk.hack';
import tetrisHack from '../hack/programs/tetris.hack';
import kbdcopyHack from '../hack/programs/kbdcopy.hack';
import sumHack from '../hack/programs/sum.hack';

interface DemoDef {
  id: string;
  title: string;
  desc: string;
  program: string;
  ramInit?: Record<number, number>;
}

const DEMOS: DemoDef[] = [
  { id: 'movblk', title: '① 弹跳方块（点屏动效）', desc: '16×16 方块对角弹跳，自编 Hack 汇编', program: movblkHack },
  { id: 'tetris', title: '② 俄罗斯方块', desc: 'nand-computer 软件轨编译产物（boot 数百万周期，请耐心；方块在移动/落底时绘制）', program: tetrisHack },
  { id: 'kbdcopy', title: '③ 键盘回显', desc: 'KBD → SCREEN[0]，按键试试', program: kbdcopyHack },
  { id: 'sum', title: '④ 求和程序', desc: 'RAM[1] = 1+2+…+RAM[0]（R0=10 → 55），跑完点"读 RAM 0..2"', program: sumHack, ramInit: { 0: 10 } },
];

const engine = createEngine(); // 全页唯一引擎（demo 切换 = 重新 load）
let machine: HackMachine;
let screen: ScreenView;
let running = false;
let cyclesPerFrame = 800;
let totalCycles = 0;
let circuitDoc: NetlistDoc | null = null;
let circuitSim: SimController | null = null;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`页面缺元素 #${id}`);
  return el as T;
};

function startDemo(def: DemoDef): void {
  machine = new HackMachine(engine, {
    program: def.program,
    ramInit: def.ramInit,
    handleIds: { rom: 'web-rom', ram: 'web-ram', screen: 'web-screen' },
  });
  (window as unknown as { __mach: HackMachine }).__mach = machine; // 调试/演示用
  totalCycles = 0;
  $('demoDesc').textContent = def.desc;
  $('statRam1').textContent = '—';
  attachCircuitView();
  renderStats();
}

/** 电路画布接入：文档加载整机网表，仿真控制器直连真引擎 */
function attachCircuitView(): void {
  const canvasEl = document.getElementById('circuit') as HTMLCanvasElement | null;
  if (!canvasEl) return;
  if (circuitDoc === null) {
    // 首次：注册芯片形状 + 建文档/控制器（Controller 自带 rAF 渲染循环）
    registerChipShapes();
    circuitDoc = new NetlistDoc(machine.netlist);
    circuitSim = new SimController(engine);
    circuitSim.setNetlistRef(machine.netlist);
    const view = new CanvasView(canvasEl);
    void new Controller(circuitDoc, circuitSim, view, {
      onStatus: (msg) => {
        $('cirStatus').textContent = msg;
      },
      onSelectionChanged: () => {},
      onToolChanged: () => {},
      onSimEvent: () => {},
    });
  } else {
    // 后续 demo 切换：换文档内容（onChange → syncEngine → 引擎重新 load）
    circuitDoc.commit(machine.netlist);
  }
}

function frame(): void {
  if (!running) return;
  const budgetMs = 12; // 留一半 16.7ms 给渲染
  const t0 = performance.now();
  let n = 0;
  while (n < cyclesPerFrame && performance.now() - t0 < budgetMs) {
    machine.cycle();
    n++;
  }
  totalCycles += n;
  screen.render(machine.screen.words);
  circuitSim?.refreshValues(); // 电路画布值表刷新（onChange → invalidate → 重绘）
  renderStats();
  requestAnimationFrame(frame);
}

function renderStats(): void {
  $('statCycles').textContent = totalCycles.toLocaleString();
  $('statPc').textContent = `0x${machine.readPc().toString(16).padStart(4, '0')}`;
  $('statA').textContent = `0x${machine.readA().toString(16).padStart(4, '0')}`;
  $('statD').textContent = machine.readD().toString();
}

function wireUi(): void {
  // demo 菜单
  const menu = $<HTMLSelectElement>('demoSelect');
  for (const d of DEMOS) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.title;
    menu.appendChild(opt);
  }
  menu.onchange = () => {
    const def = DEMOS.find((d) => d.id === menu.value)!;
    running = false;
    startDemo(def);
    screen.render(machine.screen.words);
    $('btnRun').textContent = '▶ 运行';
  };

  $('btnRun').onclick = () => {
    running = !running;
    $('btnRun').textContent = running ? '⏸ 暂停' : '▶ 运行';
    if (running) requestAnimationFrame(frame);
  };
  $('btnReset').onclick = () => {
    machine.engine.reset();
    totalCycles = 0;
    screen.render(machine.screen.words);
    circuitSim?.refreshValues();
    renderStats();
  };
  $('btnStep').onclick = () => {
    machine.cycle();
    totalCycles++;
    screen.render(machine.screen.words);
    circuitSim?.refreshValues();
    renderStats();
  };
  const speed = $<HTMLInputElement>('speed');
  speed.oninput = () => {
    cyclesPerFrame = Number(speed.value);
    $('speedVal').textContent = String(cyclesPerFrame);
  };

  // 键盘注入（避开输入控件聚焦时）
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const code = hackKeyCode(e);
    if (code < 0) return;
    e.preventDefault();
    machine.setKbd(code);
    $('kbdNow').textContent = `${code}${e.key.length === 1 ? ` ('${e.key}')` : ` (${e.key})`}`;
  });
  window.addEventListener('keyup', () => {
    machine.setKbd(0);
    $('kbdNow').textContent = '—';
  });

  // RAM 面板刷新（sum demo 用）
  $('btnRam').onclick = () => {
    $('statRam1').textContent = `R0=${machine.ramValue(0)} R1=${machine.ramValue(1)} R2=${machine.ramValue(2)}`;
  };
}

function boot(): void {
  const canvas = $<HTMLCanvasElement>('screen');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D 上下文不可用');
  screen = new ScreenView(ctx);
  wireUi();
  startDemo(DEMOS[0]!);
  screen.render(machine.screen.words);
}

void boot();
