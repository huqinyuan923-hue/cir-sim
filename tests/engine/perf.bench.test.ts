/**
 * 性能基准（M6）：
 * - 分层前馈网络：1k / 10k 门，单点扰动后 tick 的耗时（验收线：1k 门 < 5ms）
 * - 深链电路：1k / 10k 级 NOT 链，传播深度 = 门数（delta cycle 开销上界）
 *
 * 单独运行：npm run bench（= vitest run tests/perf.bench.test.ts）
 * 断言阈值留了充分余量，只作为回归护栏；实测数字以运行输出为准（记入 REPORT.md）。
 */

import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/createEngine';
import type { Netlist, SimEngine } from '../../src/contract';
import { mulberry32 } from './fuzzGen';

/** 分层前馈网络：layer0 = pins，每层 W 个门取上层 2 个输出，末层接 PIN_OUT */
function layeredNetlist(layers: number, width: number, seed: number): { netlist: Netlist; pinIds: string[] } {
  const rng = mulberry32(seed);
  const components: Netlist['components'] = [];
  const wires: Netlist['wires'] = [];
  let wid = 0;
  const gateKinds = ['AND', 'OR', 'XOR', 'NAND'] as const;
  let prev: { c: string; p: string }[] = [];
  const pinIds: string[] = [];
  for (let i = 0; i < width; i++) {
    const id = `pin${i}`;
    components.push({ id, kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} });
    pinIds.push(id);
    prev.push({ c: id, p: 'y' });
  }
  const pickSrc = (): { c: string; p: string } => {
    const s = prev[Math.floor(rng() * prev.length)]!;
    return { c: s.c, p: s.p };
  };
  for (let l = 0; l < layers; l++) {
    const cur: { c: string; p: string }[] = [];
    for (let i = 0; i < width; i++) {
      const id = `g${l}_${i}`;
      components.push({ id, kind: gateKinds[Math.floor(rng() * gateKinds.length)]!, pos: { x: 0, y: 0 }, props: {} });
      const a = pickSrc();
      const b = pickSrc();
      wires.push({ id: `w${wid++}`, from: { componentId: a.c, port: a.p }, to: { componentId: id, port: 'a' } });
      wires.push({ id: `w${wid++}`, from: { componentId: b.c, port: b.p }, to: { componentId: id, port: 'b' } });
      cur.push({ c: id, p: 'y' });
    }
    prev = cur;
  }
  // 末层接观察口（每 8 个门一个，避免 PIN_OUT 占比过高）
  for (let i = 0; i < width; i += 8) {
    const id = `o${i}`;
    components.push({ id, kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} });
    const src = prev[i]!;
    wires.push({ id: `w${wid++}`, from: { componentId: src.c, port: src.p }, to: { componentId: id, port: 'a' } });
  }
  return { netlist: { components, wires }, pinIds };
}

/** n 级 NOT 链 */
function chainNetlist(n: number): { netlist: Netlist; pinId: string } {
  const components: Netlist['components'] = [{ id: 'pin', kind: 'PIN_IN', pos: { x: 0, y: 0 }, props: {} }];
  const wires: Netlist['wires'] = [];
  let prev = { c: 'pin', p: 'y' };
  for (let i = 0; i < n; i++) {
    components.push({ id: `n${i}`, kind: 'NOT', pos: { x: 0, y: 0 }, props: {} });
    wires.push({
      id: `w${i}`,
      from: { componentId: prev.c, port: prev.p },
      to: { componentId: `n${i}`, port: 'a' },
    });
    prev = { c: `n${i}`, p: 'y' };
  }
  components.push({ id: 'out', kind: 'PIN_OUT', pos: { x: 0, y: 0 }, props: {} });
  wires.push({ id: `w${n}`, from: { componentId: prev.c, port: prev.p }, to: { componentId: 'out', port: 'a' } });
  return { netlist: { components, wires }, pinId: 'pin' };
}

interface BenchResult {
  场景: string;
  门数: string;
  tick次数: number;
  平均ms: string;
  中位ms: string;
  最大ms: string;
}

function benchPerturbTicks(
  场景: string,
  门数: string,
  engine: SimEngine,
  pinIds: string[],
  iterations: number,
): BenchResult {
  const rng = mulberry32(1234);
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const pin = pinIds[Math.floor(rng() * pinIds.length)]!;
    engine.setInput({ componentId: pin, port: 'y' }, i % 2);
    const t0 = performance.now();
    const r = engine.tick();
    const dt = performance.now() - t0;
    if (!r.stable) throw new Error(`${场景} 未收敛，基准无效`);
    times.push(dt);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, v) => s + v, 0) / times.length;
  const median = times[Math.floor(times.length / 2)]!;
  const max = times[times.length - 1]!;
  return {
    场景,
    门数,
    tick次数: iterations,
    平均ms: avg.toFixed(3),
    中位ms: median.toFixed(3),
    最大ms: max.toFixed(3),
  };
}

describe('性能基准', () => {
  it('1k 门分层网络：单点扰动 tick（验收 < 5ms）', () => {
    const { netlist, pinIds } = layeredNetlist(32, 32, 1); // 1024 门
    const engine = createEngine();
    engine.load(netlist);
    const result = benchPerturbTicks('分层前馈', '~1k 门', engine, pinIds, 200);
    console.log('BENCH', JSON.stringify(result));
    expect(parseFloat(result.中位ms)).toBeLessThan(5);
  }, 60_000);

  it('10k 门分层网络：单点扰动 tick', () => {
    const { netlist, pinIds } = layeredNetlist(50, 205, 2); // ~10.2k 门
    const engine = createEngine();
    engine.load(netlist);
    const result = benchPerturbTicks('分层前馈', '~10k 门', engine, pinIds, 100);
    console.log('BENCH', JSON.stringify(result));
    expect(parseFloat(result.中位ms)).toBeLessThan(60);
  }, 120_000);

  it('1k 级 NOT 深链：单次 tick（传播深度=门数）', () => {
    const { netlist, pinId } = chainNetlist(1000);
    const engine = createEngine();
    engine.load(netlist);
    const times: number[] = [];
    let maxSteps = 0;
    for (let i = 0; i < 20; i++) {
      engine.setInput({ componentId: pinId, port: 'y' }, i % 2);
      const t0 = performance.now();
      const r = engine.tick();
      times.push(performance.now() - t0);
      expect(r.stable).toBe(true);
      maxSteps = Math.max(maxSteps, r.steps);
    }
    // 连通性护栏：真实传播必须走过整条链（否则基准测的是空转）
    expect(maxSteps).toBeGreaterThanOrEqual(1000);
    const avg = times.reduce((s, v) => s + v, 0) / times.length;
    const result: BenchResult = {
      场景: 'NOT 深链',
      门数: '1k 级',
      tick次数: 20,
      平均ms: avg.toFixed(3),
      中位ms: times.sort((a, b) => a - b)[10]!.toFixed(3),
      最大ms: times[times.length - 1]!.toFixed(3),
    };
    console.log('BENCH', JSON.stringify(result));
    expect(avg).toBeLessThan(100);
  }, 60_000);

  it('10k 级 NOT 深链：单次 tick', () => {
    const { netlist, pinId } = chainNetlist(10_000);
    const engine = createEngine();
    engine.load(netlist);
    const times: number[] = [];
    let maxSteps = 0;
    for (let i = 0; i < 5; i++) {
      engine.setInput({ componentId: pinId, port: 'y' }, i % 2);
      const t0 = performance.now();
      const r = engine.tick();
      times.push(performance.now() - t0);
      expect(r.stable).toBe(true);
      maxSteps = Math.max(maxSteps, r.steps);
    }
    expect(maxSteps).toBeGreaterThanOrEqual(10_000);
    const avg = times.reduce((s, v) => s + v, 0) / times.length;
    const result: BenchResult = {
      场景: 'NOT 深链',
      门数: '10k 级',
      tick次数: 5,
      平均ms: avg.toFixed(3),
      中位ms: times.sort((a, b) => a - b)[2]!.toFixed(3),
      最大ms: times[times.length - 1]!.toFixed(3),
    };
    console.log('BENCH', JSON.stringify(result));
    expect(avg).toBeLessThan(400);
  }, 120_000);
});
