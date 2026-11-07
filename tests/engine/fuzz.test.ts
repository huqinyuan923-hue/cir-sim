/**
 * 模糊测试 + 差分对拍 + 序列化 round-trip 属性测试。
 *
 * - 差分对拍：随机网表 × 随机操作序列，引擎 vs 暴力参考实现，
 *   每个操作后逐端口比对取值，tick 后比对 TickResult 三元组。共 1000 个电路。
 * - round-trip：随机网表 serialize → parse ≡ 原网表，500 次。
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import { parseNetlist, serializeNetlist } from '../../src/engine/serialize';
import type { PortRef } from '../../src/contract';
import { genFuzzCase, mulberry32 } from './fuzzGen';
import { RefSim } from './referenceSim';

function assertEnginesAgree(seed: number): void {
  const { netlist, ops } = genFuzzCase(seed);
  const engine = createEngine();
  engine.load(netlist);
  const ref = new RefSim();
  ref.load(netlist);

  const compareAll = (ctx: string): void => {
    for (const port of ref.allPorts()) {
      let ev: number;
      let rv: number;
      try {
        ev = engine.read(port);
      } catch (e) {
        throw new Error(`seed=${seed} ${ctx}: 引擎读不到 ${ns(port)}：${String(e)}`);
      }
      try {
        rv = ref.read(port);
      } catch (e) {
        throw new Error(`seed=${seed} ${ctx}: 参考实现读不到 ${ns(port)}：${String(e)}`);
      }
      if (ev !== rv) {
        throw new Error(
          `seed=${seed} ${ctx}: ${ns(port)} 引擎=${ev} 参考=${rv}`,
        );
      }
    }
  };

  compareAll('load 后');
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const ctx = `op#${i}(${op.kind})`;
    if (op.kind === 'set') {
      engine.setInput(op.port, op.value);
      ref.setInput(op.port, op.value);
    } else if (op.kind === 'tick') {
      const a = engine.tick(op.maxSteps);
      const b = ref.tick(op.maxSteps);
      expect(a, `seed=${seed} ${ctx} TickResult`).toEqual(b);
    } else {
      engine.clockEdge();
      ref.clockEdge();
    }
    compareAll(ctx);
  }
}

function ns(p: PortRef): string {
  return `${p.componentId}.${p.port}`;
}

describe('差分对拍：引擎 vs 暴力参考实现（每批 100 个随机电路）', () => {
  for (let batch = 0; batch < 10; batch++) {
    it(`批次 ${batch}：seed ${batch * 100} ~ ${batch * 100 + 99} 全部一致`, () => {
      for (let i = 0; i < 100; i++) {
        assertEnginesAgree(batch * 100 + i);
      }
    });
  }
});

describe('差分对拍补充', () => {
  it('大电路（约 60 组件）也一致', () => {
    for (let i = 0; i < 20; i++) {
      const { netlist, ops } = genFuzzCase(10_000 + i, { maxComponents: 60, opsCount: 24 });
      const engine = createEngine();
      engine.load(netlist);
      const ref = new RefSim();
      ref.load(netlist);
      for (const op of ops) {
        if (op.kind === 'set') {
          engine.setInput(op.port, op.value);
          ref.setInput(op.port, op.value);
        } else if (op.kind === 'tick') {
          expect(engine.tick(op.maxSteps)).toEqual(ref.tick(op.maxSteps));
        } else {
          engine.clockEdge();
          ref.clockEdge();
        }
      }
      const a = engine.tick(512);
      const b = ref.tick(512);
      expect(a).toEqual(b);
      for (const port of ref.allPorts()) {
        expect(engine.read(port), `${port.componentId}.${port.port}`).toBe(ref.read(port));
      }
    }
  });

  it('高密度连线（多驱动/组合环频发）也一致', () => {
    for (let i = 0; i < 50; i++) {
      const { netlist, ops } = genFuzzCase(20_000 + i, { wireFactor: 3, opsCount: 20 });
      const engine = createEngine();
      engine.load(netlist);
      const ref = new RefSim();
      ref.load(netlist);
      for (const op of ops) {
        if (op.kind === 'set') {
          engine.setInput(op.port, op.value);
          ref.setInput(op.port, op.value);
        } else if (op.kind === 'tick') {
          expect(engine.tick(op.maxSteps)).toEqual(ref.tick(op.maxSteps));
        } else {
          engine.clockEdge();
          ref.clockEdge();
        }
        for (const port of ref.allPorts()) {
          if (engine.read(port) !== ref.read(port)) {
            throw new Error(`seed=${20_000 + i}: ${port.componentId}.${port.port} 不一致`);
          }
        }
      }
    }
  });

  it('幽灵端点频发（断线路径）也一致', () => {
    for (let i = 0; i < 50; i++) {
      const { netlist, ops } = genFuzzCase(30_000 + i, { ghostRate: 0.3, opsCount: 12 });
      const engine = createEngine();
      engine.load(netlist);
      const ref = new RefSim();
      ref.load(netlist);
      for (const op of ops) {
        if (op.kind === 'set') {
          engine.setInput(op.port, op.value);
          ref.setInput(op.port, op.value);
        } else if (op.kind === 'tick') {
          expect(engine.tick(op.maxSteps)).toEqual(ref.tick(op.maxSteps));
        } else {
          engine.clockEdge();
          ref.clockEdge();
        }
      }
      for (const port of ref.allPorts()) {
        expect(engine.read(port)).toBe(ref.read(port));
      }
    }
  });
});

describe('生成器自检', () => {
  it('同种子完全确定', () => {
    const a = genFuzzCase(42);
    const b = genFuzzCase(42);
    expect(a).toEqual(b);
  });

  it('不同种子产生不同网表', () => {
    const a = JSON.stringify(genFuzzCase(1).netlist);
    const b = JSON.stringify(genFuzzCase(2).netlist);
    expect(a).not.toBe(b);
  });

  it('组件 id 唯一、至少含一个 PIN_IN', () => {
    for (let seed = 0; seed < 50; seed++) {
      const { netlist } = genFuzzCase(seed);
      const ids = netlist.components.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(netlist.components.some((c) => c.kind === 'PIN_IN')).toBe(true);
    }
  });

  it('PRNG 本身可复现', () => {
    const r1 = mulberry32(7);
    const r2 = mulberry32(7);
    const seq1 = [r1(), r1(), r1()];
    const seq2 = [r2(), r2(), r2()];
    expect(seq1).toEqual(seq2);
  });
});

describe('序列化 round-trip 属性测试（随机网表 500 次）', () => {
  it('serialize ∘ parse ≡ id（500 个随机网表）', () => {
    for (let seed = 0; seed < 500; seed++) {
      const { netlist } = genFuzzCase(seed, { opsCount: 0 });
      const json = serializeNetlist(netlist);
      const { netlist: parsed, diagnostics } = parseNetlist(json);
      expect(diagnostics, `seed=${seed}`).toHaveLength(0);
      expect(parsed, `seed=${seed}`).toEqual(netlist);
      // 幂等：再次序列化字节一致
      expect(serializeNetlist(parsed!)).toBe(json);
    }
  });

  it('parse ∘ serialize ∘ parse ≡ parse（500 个随机网表）', () => {
    for (let seed = 500; seed < 1000; seed++) {
      const { netlist } = genFuzzCase(seed, { opsCount: 0 });
      const p1 = parseNetlist(serializeNetlist(netlist)).netlist!;
      const p2 = parseNetlist(serializeNetlist(p1)).netlist!;
      expect(p2).toEqual(p1);
    }
  });
});
