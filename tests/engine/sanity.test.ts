import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import type { Netlist } from '../../src/contract';

function comp(id: string, kind: string, props: Record<string, number | string> = {}): Netlist['components'][number] {
  return { id, kind, pos: { x: 0, y: 0 }, props };
}
function wire(id: string, from: { c: string; p: string }, to: { c: string; p: string }): Netlist['wires'][number] {
  return { id, from: { componentId: from.c, port: from.p }, to: { componentId: to.c, port: to.p } };
}

describe('冒烟', () => {
  it('与非门端到端：load 后自动 settle，setInput 后 tick 传播', () => {
    const e = createEngine();
    e.load({
      components: [
        comp('in1', 'PIN_IN'),
        comp('in2', 'PIN_IN'),
        comp('g', 'NAND'),
        comp('out', 'PIN_OUT'),
      ],
      wires: [
        wire('w1', { c: 'in1', p: 'y' }, { c: 'g', p: 'a' }),
        wire('w2', { c: 'in2', p: 'y' }, { c: 'g', p: 'b' }),
        wire('w3', { c: 'g', p: 'y' }, { c: 'out', p: 'a' }),
      ],
    });
    // 0,0 → NAND = 1
    expect(e.read({ componentId: 'out', port: 'a' })).toBe(1);
    // 1,1 → NAND = 0
    e.setInput({ componentId: 'in1', port: 'y' }, 1);
    e.setInput({ componentId: 'in2', port: 'y' }, 1);
    const r = e.tick();
    expect(r.stable).toBe(true);
    expect(e.read({ componentId: 'out', port: 'a' })).toBe(0);
    // 1,0 → NAND = 1
    e.setInput({ componentId: 'in2', port: 'y' }, 0);
    e.tick();
    expect(e.read({ componentId: 'out', port: 'a' })).toBe(1);
  });

  it('DFF + 时钟：两级移位寄存器每沿移动一位', () => {
    const e = createEngine();
    e.load({
      components: [
        comp('din', 'PIN_IN'),
        comp('d1', 'DFF'),
        comp('d2', 'DFF'),
        comp('o1', 'PIN_OUT'),
        comp('o2', 'PIN_OUT'),
      ],
      wires: [
        wire('w1', { c: 'din', p: 'y' }, { c: 'd1', p: 'd' }),
        wire('w2', { c: 'd1', p: 'q' }, { c: 'd2', p: 'd' }),
        wire('w3', { c: 'd1', p: 'q' }, { c: 'o1', p: 'a' }),
        wire('w4', { c: 'd2', p: 'q' }, { c: 'o2', p: 'a' }),
      ],
    });
    e.setInput({ componentId: 'din', port: 'y' }, 1);
    e.tick();
    e.clockEdge();
    e.tick();
    expect(e.read({ componentId: 'o1', port: 'a' })).toBe(1);
    expect(e.read({ componentId: 'o2', port: 'a' })).toBe(0); // 同步采样：d2 看到的是沿前 q1=0
    e.setInput({ componentId: 'din', port: 'y' }, 0);
    e.tick();
    e.clockEdge();
    e.tick();
    expect(e.read({ componentId: 'o1', port: 'a' })).toBe(0);
    expect(e.read({ componentId: 'o2', port: 'a' })).toBe(1);
  });
});
