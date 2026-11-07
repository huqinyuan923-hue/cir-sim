/**
 * 引擎行为测试：传播语义、时序电路（S-R/计数器/移位）、毛刺免疫、
 * 动态诊断（冲突/振荡）、reset 语义与 API 错误处理。
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import type { Netlist, SimEngine } from '../../src/contract';
import { NetlistBuilder, comp, ref, wire } from './helpers';

/** 三级 NOT 链：pin → n1 → n2 → n3 → out */
function notChain(n: number): { e: SimEngine; pins: string[]; outs: string[] } {
  const b = new NetlistBuilder();
  b.add('pin', 'PIN_IN');
  let prev = 'pin';
  for (let i = 0; i < n; i++) {
    b.add(`n${i}`, 'NOT');
    b.connect(ref(prev, prev === 'pin' ? 'y' : 'y'), ref(`n${i}`, 'a'));
    prev = `n${i}`;
  }
  b.add('out', 'PIN_OUT');
  b.connect(ref(prev, 'y'), ref('out', 'a'));
  const e = createEngine();
  e.load(b.build());
  return { e, pins: ['pin'], outs: ['out'] };
}

describe('传播语义', () => {
  it('load 后自动 settle：3 级 NOT 链读到稳定值', () => {
    const { e } = notChain(3);
    expect(e.read(ref('out', 'a'))).toBe(1); // 0 → 1 → 0 → 1
  });

  it('setInput 后一次 tick 逐层传播：steps = 深度 + 1（末级观察件）', () => {
    const { e } = notChain(3);
    e.setInput(ref('pin', 'y'), 1);
    const r = e.tick();
    expect(r.stable).toBe(true);
    expect(r.oscillated).toBe(false);
    expect(r.steps).toBe(4); // n1 → n2 → n3 → out（PIN_OUT 一趟空求值）
    expect(e.read(ref('out', 'a'))).toBe(0);
  });

  it('无事可做的 tick：steps=0 且 stable', () => {
    const { e } = notChain(3);
    const r = e.tick();
    expect(r).toEqual({ stable: true, steps: 0, oscillated: false });
  });

  it('setInput 相同值不触发传播', () => {
    const { e } = notChain(3);
    e.setInput(ref('pin', 'y'), 0);
    expect(e.tick().steps).toBe(0);
  });

  it('300 级长链：默认 maxSteps 足够收敛', () => {
    const { e } = notChain(300);
    e.setInput(ref('pin', 'y'), 1);
    const r = e.tick();
    expect(r.stable).toBe(true);
    expect(r.steps).toBeGreaterThanOrEqual(300);
    expect(r.steps).toBeLessThanOrEqual(310);
    expect(e.read(ref('out', 'a'))).toBe(1);
  });

  it('组合反馈回路（OR 自锁）可以收敛', () => {
    // y = en OR y：en=1 时锁到 1，en 归零后保持
    const b = new NetlistBuilder();
    b.add('en', 'PIN_IN');
    b.add('g', 'OR');
    b.add('o', 'PIN_OUT');
    b.connect(ref('en', 'y'), ref('g', 'a'));
    b.connect(ref('g', 'y'), ref('g', 'b')); // 反馈
    b.connect(ref('g', 'y'), ref('o', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('en', 'y'), 0);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0);
    e.setInput(ref('en', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(1); // 0→1→1 收敛于 1
    e.setInput(ref('en', 'y'), 0);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(1); // 自锁保持
  });
});

describe('S-R 锁存器（交叉耦合 NAND + 输入反相）', () => {
  /**
   * 结构：sBar = NOT(S)，rBar = NOT(R)
   *       q  = NAND(sBar, qn)
   *       qn = NAND(rBar, q)
   * 说明：单元延迟模型下，对称初态（q=qn）的交叉耦合回路会振荡，
   * 这是零延迟仿真的经典现象；先用置位/复位打破对称即可正常工作（见 REPORT.md）。
   */
  function srLatch(): { e: SimEngine; q: string; qn: string } {
    const b = new NetlistBuilder();
    b.add('s', 'PIN_IN');
    b.add('r', 'PIN_IN');
    b.add('ns', 'NOT');
    b.add('nr', 'NOT');
    b.add('lq', 'NAND'); // q = NAND(sBar, qn)
    b.add('lqn', 'NAND'); // qn = NAND(rBar, q)
    b.add('oq', 'PIN_OUT');
    b.add('oqn', 'PIN_OUT');
    b.connect(ref('s', 'y'), ref('ns', 'a'));
    b.connect(ref('r', 'y'), ref('nr', 'a'));
    b.connect(ref('ns', 'y'), ref('lq', 'a'));
    b.connect(ref('lqn', 'y'), ref('lq', 'b'));
    b.connect(ref('nr', 'y'), ref('lqn', 'a'));
    b.connect(ref('lq', 'y'), ref('lqn', 'b'));
    b.connect(ref('lq', 'y'), ref('oq', 'a'));
    b.connect(ref('lqn', 'y'), ref('oqn', 'a'));
    const e = createEngine();
    e.load(b.build());
    return { e, q: 'oq', qn: 'oqn' };
  }

  it('置位：S=1 → q=1（振荡的对称初态被打破）', () => {
    const { e, q, qn } = srLatch();
    e.setInput(ref('s', 'y'), 1);
    e.setInput(ref('r', 'y'), 0);
    const r = e.tick(64);
    expect(r.stable).toBe(true);
    expect(e.read(ref(q, 'a'))).toBe(1);
    expect(e.read(ref(qn, 'a'))).toBe(0);
  });

  it('保持：S 归零后 q 保持 1', () => {
    const { e, q, qn } = srLatch();
    e.setInput(ref('s', 'y'), 1);
    e.tick(64);
    e.setInput(ref('s', 'y'), 0);
    e.tick(64);
    expect(e.read(ref(q, 'a'))).toBe(1);
    expect(e.read(ref(qn, 'a'))).toBe(0);
  });

  it('复位：R=1 → q=0', () => {
    const { e, q, qn } = srLatch();
    e.setInput(ref('s', 'y'), 1);
    e.tick(64);
    e.setInput(ref('s', 'y'), 0);
    e.setInput(ref('r', 'y'), 1);
    e.tick(64);
    expect(e.read(ref(q, 'a'))).toBe(0);
    expect(e.read(ref(qn, 'a'))).toBe(1);
  });

  it('振荡案例：S=R=1 双一态释放 → 无限振荡，tick 报 oscillated', () => {
    const { e, q, qn } = srLatch();
    e.setInput(ref('s', 'y'), 1);
    e.setInput(ref('r', 'y'), 1);
    e.tick(64); // 非法态：q=qn=1
    expect(e.read(ref(q, 'a'))).toBe(1);
    expect(e.read(ref(qn, 'a'))).toBe(1);
    e.setInput(ref('s', 'y'), 0);
    e.setInput(ref('r', 'y'), 0);
    const r = e.tick(64);
    expect(r.oscillated).toBe(true);
    expect(r.stable).toBe(false);
    expect(r.steps).toBe(64);
  });

  it('振荡时诊断含 oscillation（error），置位打破后清除', () => {
    const { e, q } = srLatch();
    e.setInput(ref('s', 'y'), 1);
    e.setInput(ref('r', 'y'), 1);
    e.tick(64);
    e.setInput(ref('s', 'y'), 0);
    e.setInput(ref('r', 'y'), 0);
    e.tick(64);
    const osc = e.diagnostics().filter((d) => d.kind === 'oscillation');
    expect(osc).toHaveLength(1);
    expect(osc[0]!.level).toBe('error');
    expect(osc[0]!.componentIds!).toContain('lq');
    expect(osc[0]!.componentIds!).toContain('lqn');
    // 打破振荡：强制置位
    e.setInput(ref('s', 'y'), 1);
    const r = e.tick(64);
    expect(r.stable).toBe(true);
    expect(e.read(ref(q, 'a'))).toBe(1);
    expect(e.diagnostics().filter((d) => d.kind === 'oscillation')).toHaveLength(0);
  });

  it('非门自环：最小振荡器', () => {
    const e = createEngine();
    e.load({
      components: [comp('n', 'NOT')],
      wires: [wire('w', { c: 'n', p: 'y' }, { c: 'n', p: 'a' })],
    });
    const r = e.tick(50);
    expect(r.oscillated).toBe(true);
    expect(r.steps).toBe(50);
  });
});

describe('同步计数器（DFF 搭建，4 位）', () => {
  function counter(): SimEngine {
    const b = new NetlistBuilder();
    b.add('one', 'CONST', { value: 1 });
    b.add('x0', 'XOR'); // d0 = q0 ^ 1
    b.add('a10', 'AND'); // T1 = q0
    b.add('x1', 'XOR'); // d1 = q1 ^ T1
    b.add('a20', 'AND'); // T2 = q0 & q1
    b.add('a21', 'AND');
    b.add('x2', 'XOR'); // d2 = q2 ^ T2
    b.add('a30', 'AND'); // T3 = q0 & q1 & q2
    b.add('a31', 'AND');
    b.add('a32', 'AND');
    b.add('x3', 'XOR'); // d3 = q3 ^ T3
    const dffs = ['f0', 'f1', 'f2', 'f3'].map((id) => ({ id }));
    for (const f of dffs) b.add(f.id, 'DFF');
    const outs = ['q0', 'q1', 'q2', 'q3'];
    for (const o of outs) b.add(o, 'PIN_OUT');

    b.connect(ref('one', 'y'), ref('x0', 'b'));
    b.connect(ref('f0', 'q'), ref('x0', 'a'));
    b.connect(ref('f0', 'q'), ref('a10', 'a'));
    b.connect(ref('f0', 'q'), ref('a10', 'b')); // T1 = q0 & q0 = q0
    b.connect(ref('f1', 'q'), ref('x1', 'a'));
    b.connect(ref('a10', 'y'), ref('x1', 'b'));
    b.connect(ref('f0', 'q'), ref('a20', 'a'));
    b.connect(ref('f1', 'q'), ref('a20', 'b'));
    b.connect(ref('a20', 'y'), ref('a21', 'a'));
    b.connect(ref('a20', 'y'), ref('a21', 'b')); // T2 = T2' & T2' = T2'
    b.connect(ref('f2', 'q'), ref('x2', 'a'));
    b.connect(ref('a21', 'y'), ref('x2', 'b'));
    b.connect(ref('f0', 'q'), ref('a30', 'a'));
    b.connect(ref('f1', 'q'), ref('a30', 'b'));
    b.connect(ref('f2', 'q'), ref('a31', 'a'));
    b.connect(ref('a30', 'y'), ref('a31', 'b'));
    b.connect(ref('a31', 'y'), ref('a32', 'a'));
    b.connect(ref('a31', 'y'), ref('a32', 'b'));
    b.connect(ref('f3', 'q'), ref('x3', 'a'));
    b.connect(ref('a32', 'y'), ref('x3', 'b'));

    b.connect(ref('x0', 'y'), ref('f0', 'd'));
    b.connect(ref('x1', 'y'), ref('f1', 'd'));
    b.connect(ref('x2', 'y'), ref('f2', 'd'));
    b.connect(ref('x3', 'y'), ref('f3', 'd'));
    b.connect(ref('f0', 'q'), ref('q0', 'a'));
    b.connect(ref('f1', 'q'), ref('q1', 'a'));
    b.connect(ref('f2', 'q'), ref('q2', 'a'));
    b.connect(ref('f3', 'q'), ref('q3', 'a'));
    const e = createEngine();
    e.load(b.build());
    return e;
  }

  it('自由运行：k 个沿后计数值 = k（mod 16）', () => {
    const e = counter();
    const readAll = (): number =>
      [0, 1, 2, 3].reduce((acc, i) => acc | (e.read(ref(`q${i}`, 'a')) << i), 0);
    expect(readAll()).toBe(0);
    for (let k = 1; k <= 17; k++) {
      e.clockEdge();
      e.tick();
      expect(readAll()).toBe(k % 16);
    }
  });
});

describe('移位寄存器与同步采样', () => {
  function shiftReg(stages: number): { e: SimEngine; qs: string[] } {
    const b = new NetlistBuilder();
    b.add('din', 'PIN_IN');
    let prevOut = 'din';
    const qs: string[] = [];
    for (let i = 0; i < stages; i++) {
      b.add(`f${i}`, 'DFF');
      b.connect(ref(prevOut, prevOut === 'din' ? 'y' : 'q'), ref(`f${i}`, 'd'));
      b.add(`q${i}`, 'PIN_OUT');
      b.connect(ref(`f${i}`, 'q'), ref(`q${i}`, 'a'));
      qs.push(`q${i}`);
      prevOut = `f${i}`;
    }
    const e = createEngine();
    e.load(b.build());
    return { e, qs };
  }

  it('每个沿整链同步移动一位（从级采样沿前主级值）', () => {
    const { e, qs } = shiftReg(4);
    const readAll = (): number[] => qs.map((q) => e.read(ref(q, 'a')));
    e.setInput(ref('din', 'y'), 1);
    e.tick();
    e.clockEdge();
    e.tick();
    expect(readAll()).toEqual([1, 0, 0, 0]); // 后级全部采到沿前的 0
    e.clockEdge();
    e.tick();
    expect(readAll()).toEqual([1, 1, 0, 0]);
    e.setInput(ref('din', 'y'), 0);
    e.tick();
    e.clockEdge();
    e.tick();
    e.clockEdge();
    e.tick();
    expect(readAll()).toEqual([0, 0, 1, 1]);
  });

  it('q 只在 clockEdge 变化：d 反复翻转期间 q 纹丝不动', () => {
    const { e, qs } = shiftReg(1);
    const q = (): number => e.read(ref(qs[0]!, 'a'));
    for (const v of [1, 0, 1, 1, 0]) {
      e.setInput(ref('din', 'y'), v);
      e.tick();
      expect(q()).toBe(0); // 无论 d 怎么变，没有沿就没有锁存
    }
    e.clockEdge();
    expect(q()).toBe(0); // 最后一个 d=0
    e.setInput(ref('din', 'y'), 1);
    e.tick();
    e.clockEdge();
    expect(q()).toBe(1);
  });
});

describe('毛刺免疫', () => {
  /** d = a XOR (NOT b)：构造传播期 d 的中间毛刺 */
  function glitchCircuit(): SimEngine {
    const b = new NetlistBuilder();
    b.add('a', 'PIN_IN');
    b.add('b', 'PIN_IN');
    b.add('nb', 'NOT');
    b.add('x', 'XOR');
    b.add('f', 'DFF');
    b.add('q', 'PIN_OUT');
    b.add('dprobe', 'PIN_OUT'); // 观察 d
    b.connect(ref('a', 'y'), ref('x', 'a'));
    b.connect(ref('b', 'y'), ref('nb', 'a'));
    b.connect(ref('nb', 'y'), ref('x', 'b'));
    b.connect(ref('x', 'y'), ref('f', 'd'));
    b.connect(ref('f', 'q'), ref('q', 'a'));
    b.connect(ref('x', 'y'), ref('dprobe', 'a'));
    const e = createEngine();
    e.load(b.build());
    return e;
  }

  it('传播期 d 出现毛刺 1，q 不受影响；沿采样的是稳定值 0', () => {
    const e = glitchCircuit();
    // 稳态：a=0, b=1 → nb=0 → d=0
    e.setInput(ref('b', 'y'), 1);
    e.tick();
    expect(e.read(ref('dprobe', 'a'))).toBe(0);
    // 同一拍里 a: 0→1、b: 1→0：单步 delta 里 XOR 先看到 a=1、旧 nb=0 → d=1（毛刺）
    e.setInput(ref('a', 'y'), 1);
    e.setInput(ref('b', 'y'), 0);
    const mid = e.tick(1); // 只走一个 delta
    expect(mid.steps).toBe(1);
    expect(e.read(ref('dprobe', 'a'))).toBe(1); // 毛刺可见
    expect(e.read(ref('q', 'a'))).toBe(0); // 但 q 纹丝不动（毛刺免疫）
    // 继续传播到稳定：d = 1 XOR NOT(0)=1^1 = 0
    const rest = e.tick();
    expect(rest.stable).toBe(true);
    expect(e.read(ref('dprobe', 'a'))).toBe(0);
    e.clockEdge();
    expect(e.read(ref('q', 'a'))).toBe(0); // 沿锁存的是稳定值 0，不是毛刺 1
  });

  it('用户若在毛刺未落定时强行打沿，则锁存当前 net 值（语义明确化）', () => {
    const e = glitchCircuit();
    e.setInput(ref('b', 'y'), 1);
    e.tick();
    e.setInput(ref('a', 'y'), 1);
    e.setInput(ref('b', 'y'), 0);
    e.tick(1); // d=1（中间态）
    e.clockEdge(); // 在中间态打沿
    expect(e.read(ref('q', 'a'))).toBe(1); // 锁存 1：clockEdge 采样"当下"的 net 值
  });
});

describe('多驱动冲突', () => {
  function conflictCircuit(): SimEngine {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN');
    b.add('ctl', 'PIN_IN');
    b.add('g', 'AND');
    b.add('o', 'PIN_OUT');
    b.connect(ref('ctl', 'y'), ref('g', 'a'));
    b.connect(ref('ctl', 'y'), ref('g', 'b')); // g 输出 = ctl
    b.connect(ref('p', 'y'), ref('o', 'a'));
    b.connect(ref('g', 'y'), ref('o', 'a')); // pin 与门输出共网
    const e = createEngine();
    e.load(b.build());
    return e;
  }

  it('两驱动不同值：conflict（error）诊断 + 冲突位按线与取 0', () => {
    const e = conflictCircuit();
    e.setInput(ref('ctl', 'y'), 1); // p=0, g=1 → 冲突
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0); // 线与：1 & 0 = 0
    const conflicts = e.diagnostics().filter((d) => d.kind === 'conflict' && d.level === 'error');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.componentIds!.sort()).toEqual(['g', 'p']);
  });

  it('驱动值一致后冲突自动消除', () => {
    const e = conflictCircuit();
    e.setInput(ref('ctl', 'y'), 1);
    e.tick();
    expect(e.diagnostics().filter((d) => d.kind === 'conflict' && d.level === 'error')).toHaveLength(1);
    e.setInput(ref('p', 'y'), 1); // p=1, g=1 → 同值
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(1);
    expect(e.diagnostics().filter((d) => d.kind === 'conflict' && d.level === 'error')).toHaveLength(0);
  });

  it('两个门输出同网同值：不报冲突', () => {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN');
    b.add('g1', 'NOT');
    b.add('g2', 'NOT');
    b.add('o', 'PIN_OUT');
    b.connect(ref('p', 'y'), ref('g1', 'a'));
    b.connect(ref('p', 'y'), ref('g2', 'a'));
    b.connect(ref('g1', 'y'), ref('o', 'a'));
    b.connect(ref('g2', 'y'), ref('o', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('p', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0);
    expect(e.diagnostics().filter((d) => d.kind === 'conflict' && d.level === 'error')).toHaveLength(0);
  });
});

describe('reset 语义', () => {
  it('reset 清掉 DFF 状态、保留 PIN_IN 激励，组合逻辑重收敛', () => {
    const b2 = new NetlistBuilder();
    b2.add('d', 'PIN_IN');
    b2.add('f', 'DFF');
    b2.add('g', 'AND');
    b2.add('q', 'PIN_OUT');
    b2.add('gp', 'PIN_OUT');
    b2.connect(ref('d', 'y'), ref('f', 'd'));
    b2.connect(ref('f', 'q'), ref('q', 'a'));
    b2.connect(ref('d', 'y'), ref('g', 'a'));
    b2.connect(ref('d', 'y'), ref('g', 'b'));
    b2.connect(ref('g', 'y'), ref('gp', 'a'));
    const e = createEngine();
    e.load(b2.build());
    e.setInput(ref('d', 'y'), 1);
    e.tick();
    e.clockEdge();
    e.tick();
    expect(e.read(ref('q', 'a'))).toBe(1);
    expect(e.read(ref('gp', 'a'))).toBe(1);
    e.reset();
    expect(e.read(ref('q', 'a'))).toBe(0); // DFF 状态归零
    expect(e.read(ref('gp', 'a'))).toBe(1); // 组合逻辑按保留的激励重收敛
    expect(e.read(ref('d', 'y'))).toBe(1); // 激励保留
    e.clockEdge();
    e.tick();
    expect(e.read(ref('q', 'a'))).toBe(1); // 复位后可继续工作
  });
});

describe('API 错误处理', () => {
  it('未 load 时 read/setInput 抛错，tick 返回稳定空结果，clockEdge 无害', () => {
    const e = createEngine();
    expect(() => e.read(ref('x', 'y'))).toThrow();
    expect(() => e.setInput(ref('x', 'y'), 1)).toThrow();
    expect(e.tick()).toEqual({ stable: true, steps: 0, oscillated: false });
    expect(() => e.clockEdge()).not.toThrow();
    expect(e.diagnostics()).toEqual([]);
  });

  it('read 未知组件 / 未知端口抛错', () => {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN');
    b.add('o', 'PIN_OUT');
    b.connect(ref('p', 'y'), ref('o', 'a'));
    const e = createEngine();
    e.load(b.build());
    expect(() => e.read(ref('ghost', 'y'))).toThrow();
    expect(() => e.read(ref('p', 'nope'))).toThrow();
  });

  it('setInput 只接受 PIN_IN：门端口/未知组件抛错', () => {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN');
    b.add('g', 'AND');
    b.connect(ref('p', 'y'), ref('g', 'a'));
    const e = createEngine();
    e.load(b.build());
    expect(() => e.setInput(ref('g', 'y'), 1)).toThrow(/PIN_IN/);
    expect(() => e.setInput(ref('ghost', 'y'), 1)).toThrow();
    expect(() => e.setInput(ref('p', 'q'), 1)).toThrow(); // PIN_IN 没有 q 端口
    expect(() => e.setInput(ref('p', 'y'), 1)).not.toThrow();
  });

  it('PIN_IN 宽度可用字符串声明', () => {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN', { width: '8' });
    b.add('o', 'PIN_OUT', { width: '8' });
    b.connect(ref('p', 'y'), ref('o', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('p', 'y'), 0xab);
    expect(e.read(ref('o', 'a'))).toBe(0xab);
  });
});

describe('悬空输入的行为', () => {
  it('未驱动的输入按 0 参与运算，并给出 floating 警告', () => {
    const b = new NetlistBuilder();
    b.add('p', 'PIN_IN');
    b.add('g', 'AND');
    b.add('o', 'PIN_OUT');
    b.connect(ref('p', 'y'), ref('g', 'a'));
    // g.b 悬空
    b.connect(ref('g', 'y'), ref('o', 'a'));
    const e = createEngine();
    e.load(b.build());
    e.setInput(ref('p', 'y'), 1);
    e.tick();
    expect(e.read(ref('o', 'a'))).toBe(0); // 悬空 = 0
    const floats = e.diagnostics().filter((d) => d.kind === 'floating' && d.level === 'warning');
    expect(floats.length).toBe(1); // g.b 单端口 net
    expect(floats[0]!.componentIds).toEqual(['g']);
  });
});

describe('tick 语义补充', () => {
  it('显式 maxSteps=1 且无事发生：stable', () => {
    const { e } = notChain(3);
    expect(e.tick(1)).toEqual({ stable: true, steps: 0, oscillated: false });
  });

  it('振荡后继续 tick 从断点推进（不重置步数）', () => {
    const e = createEngine();
    e.load({
      components: [comp('n', 'NOT')],
      wires: [wire('w', { c: 'n', p: 'y' }, { c: 'n', p: 'a' })],
    });
    const r1 = e.tick(10);
    expect(r1.oscillated).toBe(true);
    const r2 = e.tick(5);
    expect(r2.steps).toBe(5); // 继续振荡
    // 打破振荡后恢复稳定
    e.registerBehavior('NOT', {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ y: 0 }), // 覆盖成恒 0 → 回路稳定
    });
    const r3 = e.tick(100);
    expect(r3.stable).toBe(true);
  });
});

describe('混合时序电路：DFF + 组合反馈（模 3 计数器）', () => {
  it('状态 0→1→2→0 循环', () => {
    // 状态 q1q0：next(0)=1, next(1)=2, next(2)=0, next(3)=0
    // 方程：d0 = ~q1 & ~q0；d1 = q0 & ~q1
    const b = new NetlistBuilder();
    b.add('n0', 'NOT');
    b.add('n1', 'NOT');
    b.add('a0', 'AND'); // d0 = ~q1 & ~q0
    b.add('a1', 'AND'); // d1 = q0 & ~q1
    b.add('f0', 'DFF');
    b.add('f1', 'DFF');
    b.add('q0', 'PIN_OUT');
    b.add('q1', 'PIN_OUT');

    b.connect(ref('f0', 'q'), ref('n0', 'a'));
    b.connect(ref('f1', 'q'), ref('n1', 'a'));
    b.connect(ref('n1', 'y'), ref('a0', 'a'));
    b.connect(ref('n0', 'y'), ref('a0', 'b'));
    b.connect(ref('f0', 'q'), ref('a1', 'a'));
    b.connect(ref('n1', 'y'), ref('a1', 'b'));
    b.connect(ref('a0', 'y'), ref('f0', 'd'));
    b.connect(ref('a1', 'y'), ref('f1', 'd'));
    b.connect(ref('f0', 'q'), ref('q0', 'a'));
    b.connect(ref('f1', 'q'), ref('q1', 'a'));
    const e = createEngine();
    e.load(b.build());
    const state = (): number => e.read(ref('q0', 'a')) | (e.read(ref('q1', 'a')) << 1);
    const seen: number[] = [state()];
    for (let i = 0; i < 7; i++) {
      e.clockEdge();
      e.tick();
      seen.push(state());
    }
    expect(seen).toEqual([0, 1, 2, 0, 1, 2, 0, 1]);
  });
});
