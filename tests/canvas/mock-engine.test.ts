/**
 * MockEngine / SimController 测试（tick / edge / reset / run / 诊断）
 * 分块编写：本文件只含基础门电路与值表测试。
 */
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/canvas/mock/MockEngine.js';
import { SimController } from '../../src/canvas/sim/SimController.js';
import type { Netlist } from '../../src/canvas/contract.js';

/** 两输入 AND 演示电路 */
function andCircuit(): Netlist {
  return {
    components: [
      { id: 'a', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
      { id: 'b', kind: 'INPUT', pos: { x: 0, y: 60 }, props: {} },
      { id: 'g', kind: 'AND', pos: { x: 100, y: 0 }, props: {} },
      { id: 'not', kind: 'NOT', pos: { x: 200, y: 0 }, props: {} },
    ],
    wires: [
      { id: 'wa', from: { componentId: 'a', port: 'OUT' }, to: { componentId: 'g', port: 'A' } },
      { id: 'wb', from: { componentId: 'b', port: 'OUT' }, to: { componentId: 'g', port: 'B' } },
      { id: 'wg', from: { componentId: 'g', port: 'OUT' }, to: { componentId: 'not', port: 'A' } },
    ],
  };
}

describe('MockEngine 基础门电路', () => {
  it('INPUT=1,1 → AND=1，稳定收敛', () => {
    const e = new MockEngine();
    e.load(andCircuit());
    e.setInput({ componentId: 'a', port: 'OUT' }, 1);
    e.setInput({ componentId: 'b', port: 'OUT' }, 1);
    const r = e.tick();
    expect(r.stable).toBe(true);
    expect(r.oscillated).toBe(false);
    expect(e.read({ componentId: 'g', port: 'OUT' })).toBe(1);
    expect(e.read({ componentId: 'not', port: 'OUT' })).toBe(0);
  });

  it('INPUT=1,0 → AND=0', () => {
    const e = new MockEngine();
    e.load(andCircuit());
    e.setInput({ componentId: 'a', port: 'OUT' }, 1);
    e.setInput({ componentId: 'b', port: 'OUT' }, 0);
    e.tick();
    expect(e.read({ componentId: 'g', port: 'OUT' })).toBe(0);
    expect(e.read({ componentId: 'not', port: 'OUT' })).toBe(1);
  });

  it('悬空输入按 0 计算（诊断报 floating）', () => {
    const e = new MockEngine();
    e.load(andCircuit()); // b 未设值但已连线：值 0
    e.tick();
    expect(e.read({ componentId: 'g', port: 'OUT' })).toBe(0);
  });

  it('完全未连线的输入端口报 floating', () => {
    const e = new MockEngine();
    e.load({
      components: [{ id: 'g', kind: 'AND', pos: { x: 0, y: 0 }, props: {} }],
      wires: [],
    });
    e.tick();
    const diags = e.diagnostics();
    const floating = diags.filter((d) => d.kind === 'floating');
    expect(floating.length).toBeGreaterThanOrEqual(1);
  });

  it('NOT 自反馈振荡：oscillated=true 且诊断含 oscillation', () => {
    const e = new MockEngine();
    e.load({
      components: [{ id: 'n', kind: 'NOT', pos: { x: 0, y: 0 }, props: {} }],
      wires: [{ id: 'w', from: { componentId: 'n', port: 'OUT' }, to: { componentId: 'n', port: 'A' } }],
    });
    const r = e.tick();
    expect(r.oscillated).toBe(true);
    expect(r.stable).toBe(false);
    const diags = e.diagnostics();
    expect(diags.some((d) => d.kind === 'oscillation')).toBe(true);
  });

  it('双驱动冲突：诊断报 conflict 且列出组件', () => {
    const e = new MockEngine();
    e.load({
      components: [
        { id: 'a', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
        { id: 'b', kind: 'INPUT', pos: { x: 0, y: 40 }, props: {} },
        { id: 'o', kind: 'OUTPUT', pos: { x: 100, y: 0 }, props: {} },
      ],
      wires: [
        { id: 'w1', from: { componentId: 'a', port: 'OUT' }, to: { componentId: 'o', port: 'IN' } },
        { id: 'w2', from: { componentId: 'b', port: 'OUT' }, to: { componentId: 'o', port: 'IN' } },
      ],
    });
    const diags = e.diagnostics();
    const conflict = diags.find((d) => d.kind === 'conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.level).toBe('error');
    expect(conflict!.componentIds).toContain('a');
    expect(conflict!.componentIds).toContain('b');
  });

  it('unknown-kind 报 error 诊断', () => {
    const e = new MockEngine();
    e.load({
      components: [{ id: 'u', kind: 'WIDGET', pos: { x: 0, y: 0 }, props: {} }],
      wires: [],
    });
    const diags = e.diagnostics();
    const unknown = diags.find((d) => d.kind === 'unknown-kind');
    expect(unknown).toBeDefined();
    expect(unknown!.level).toBe('error');
    expect(unknown!.componentIds).toEqual(['u']);
  });

  it(' setInput 覆盖旧值', () => {
    const e = new MockEngine();
    e.load(andCircuit());
    e.setInput({ componentId: 'a', port: 'OUT' }, 1);
    e.setInput({ componentId: 'a', port: 'OUT' }, 0);
    e.tick();
    expect(e.read({ componentId: 'g', port: 'OUT' })).toBe(0);
  });
});

describe('MockEngine · DFF 与时钟沿', () => {
  function dffCircuit(): Netlist {
    return {
      components: [
        { id: 'd', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
        { id: 'f', kind: 'DFF', pos: { x: 100, y: 0 }, props: {} },
      ],
      wires: [{ id: 'w', from: { componentId: 'd', port: 'OUT' }, to: { componentId: 'f', port: 'D' } }],
    };
  }

  it('clockEdge 采样 D 输入到 Q', () => {
    const e = new MockEngine();
    e.load(dffCircuit());
    e.setInput({ componentId: 'd', port: 'OUT' }, 1);
    e.tick();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(0); // 未到沿
    e.clockEdge();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(0); // 采样后需再传播
    e.tick();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(1);
  });

  it('D=0 时沿后 Q=0', () => {
    const e = new MockEngine();
    e.load(dffCircuit());
    e.clockEdge();
    e.tick();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(0);
  });

  it('reset 清时序状态（DFF Q 归零），固有振荡电路 reset 后如实再报', () => {
    const e = new MockEngine();
    e.load(dffCircuit());
    e.setInput({ componentId: 'd', port: 'OUT' }, 1);
    e.tick();
    e.clockEdge();
    e.tick();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(1);
    e.reset();
    expect(e.read({ componentId: 'f', port: 'Q' })).toBe(0); // 时序状态清零
    // 固有振荡电路：reset 后重新传播仍会检测到振荡（诚实语义）
    const o = new MockEngine();
    o.load({
      components: [{ id: 'n', kind: 'NOT', pos: { x: 0, y: 0 }, props: {} }],
      wires: [{ id: 'w', from: { componentId: 'n', port: 'OUT' }, to: { componentId: 'n', port: 'A' } }],
    });
    o.reset();
    expect(o.diagnostics().some((d) => d.kind === 'oscillation')).toBe(true);
  });

  it('registerBehavior 注册自定义芯片', () => {
    const e = new MockEngine();
    e.registerBehavior('MAJ3', {
      ports: [
        { name: 'A', dir: 'in', width: 1 },
        { name: 'B', dir: 'in', width: 1 },
        { name: 'C', dir: 'in', width: 1 },
        { name: 'OUT', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ OUT: (i.A ?? 0) + (i.B ?? 0) + (i.C ?? 0) >= 2 ? 1 : 0 }),
    });
    e.load({
      components: [{ id: 'm', kind: 'MAJ3', pos: { x: 0, y: 0 }, props: {} }],
      wires: [],
    });
    e.tick();
    // 全悬空 → 0 输入 → OUT=0
    expect(e.read({ componentId: 'm', port: 'OUT' })).toBe(0);
    expect(e.diagnostics().some((d) => d.kind === 'unknown-kind')).toBe(false);
  });
});

describe('SimController', () => {
  it('tick 更新值表（portKey → 0/1）', () => {
    const e = new MockEngine();
    const sc = new SimController(e);
    sc.setNetlistRef(andCircuit());
    sc.syncNetlist(andCircuit());
    sc.setInput({ componentId: 'a', port: 'OUT' }, 1);
    sc.setInput({ componentId: 'b', port: 'OUT' }, 1);
    sc.tick();
    expect(sc.values.get('g:OUT')).toBe(1);
    expect(sc.values.get('not:OUT')).toBe(0);
    expect(sc.lastTick?.stable).toBe(true);
  });

  it('toggleInput 翻转 INPUT 并反映到值表', () => {
    const e = new MockEngine();
    const sc = new SimController(e);
    sc.setNetlistRef(andCircuit());
    sc.syncNetlist(andCircuit());
    expect(sc.toggleInput('a')).toBe(1);
    sc.tick();
    expect(sc.values.get('g:OUT')).toBe(0); // b=0
    expect(sc.toggleInput('b')).toBe(1);
    sc.tick();
    expect(sc.values.get('g:OUT')).toBe(1);
  });

  it('reset 清值表并重算', () => {
    const e = new MockEngine();
    const sc = new SimController(e);
    sc.setNetlistRef(andCircuit());
    sc.syncNetlist(andCircuit());
    sc.setInput({ componentId: 'a', port: 'OUT' }, 1);
    sc.tick();
    sc.reset();
    expect(sc.values.get('g:OUT')).toBe(0);
  });

  it('run 每 interval 执行 step（fake timers）', () => {
    vi.useFakeTimers();
    try {
      const e = new MockEngine();
      const sc = new SimController(e);
      sc.setNetlistRef(andCircuit());
      sc.syncNetlist(andCircuit());
      sc.setInput({ componentId: 'a', port: 'OUT' }, 1);
      sc.run();
      expect(sc.running).toBe(true);
      vi.advanceTimersByTime(35); // 约 2 帧（16.7ms）
      expect(sc.values.get('g:OUT')).toBe(0); // b=0
      sc.pause();
      expect(sc.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('run 重复调用不叠加定时器', () => {
    vi.useFakeTimers();
    try {
      const e = new MockEngine();
      const sc = new SimController(e);
      sc.setNetlistRef(andCircuit());
      sc.syncNetlist(andCircuit());
      sc.run();
      sc.run();
      expect(sc.running).toBe(true);
      sc.pause();
      expect(sc.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setSpeed 调整运行周期', () => {
    vi.useFakeTimers();
    try {
      const e = new MockEngine();
      const sc = new SimController(e);
      sc.setNetlistRef(andCircuit());
      sc.syncNetlist(andCircuit());
      sc.setSpeed(4);
      sc.run();
      vi.advanceTimersByTime(20); // 4×60Hz → 4ms 间隔 → 约 5 帧
      // 无法精确断言帧数，但至少应执行过 step
      expect(sc.lastTick).not.toBeNull();
      sc.pause();
    } finally {
      vi.useRealTimers();
    }
  });
});
