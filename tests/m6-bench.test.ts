/**
 * M6 · 性能基准（npm run bench）。
 *
 * 口径说明（对齐任务书"Hack 全机一帧约 500 万门事件，模拟 1 秒真实时间 < 200ms"）：
 * - "门事件" 计数为芯片 evaluate + onClockEdge 的调用次数（行为包装器统计），
 *   即一次完整的芯片求值，粒度等价于门级仿真的门求值；
 * - 每个 Hack 周期 = 2 次 tick（组合收敛）+ 1 次 clockEdge；
 * - 一帧取画布 60fps 预算内可跑的周期数，目标换算：500 万门事件耗时 < 200ms。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChipBehavior } from '../src/contract';
import { createEngine } from '../src/engine/createEngine';
import { HackMachine, buildComputerNetlist } from '../src/hack/computer';
import { chipLibrary } from '../src/chips/registerAll';
import { ALU_BEHAVIOR } from '../src/chips/alu';
import { PC_BEHAVIOR } from '../src/chips/seq';
import { makeRam } from '../src/chips/memory';
import { expand } from '../src/expand/expand';
import { loadGolden } from './helpers/golden';
import { buildChipBench, runCombGolden, runClockedGolden } from '../src/testkit/harness';

const here = dirname(fileURLToPath(import.meta.url));

/** 行为计数包装器 */
function makeCounter() {
  const counts = { evaluate: 0, clockEdge: 0 };
  const wrap = (_kind: string, b: ChipBehavior): ChipBehavior => ({
    ports: b.ports,
    initState: b.initState,
    evaluate: (i, s, p) => {
      counts.evaluate++;
      return b.evaluate(i, s, p);
    },
    onClockEdge: b.onClockEdge
      ? (i, s, p) => {
          counts.clockEdge++;
          b.onClockEdge!(i, s, p);
        }
      : undefined,
  });
  return { counts, wrap };
}

describe('M6 · 性能基准', () => {
  it('Hack 全机吞吐：周期当量耗时、周期/秒、芯片求值/周期', () => {
    const { counts, wrap } = makeCounter();
    const program = readFileSync(join(here, '..', 'src', 'hack', 'programs', 'movblk.hack'), 'utf-8');
    const m = new HackMachine(createEngine(), { program, behaviorWrapper: wrap });

    const N = 5000;
    counts.evaluate = 0;
    counts.clockEdge = 0;
    const ms = m.runCycles(N);

    const perCycle = (counts.evaluate + counts.clockEdge) / N; // 芯片求值/周期
    const msPerCycle = ms / N;
    const cps = N / (ms / 1000); // 周期/秒
    // 口径换算（REPORT.md §性能）：
    // nand2tetris 门级全机 ≈ 150 万门；"一帧 ≈ 500 万门事件" ≈ 1~3 个 Hack 周期的门级仿真量。
    // 本部宽粒度机器的"帧当量" = 1 个 Hack 周期 = perCycle 次芯片求值，耗时 msPerCycle。
    const frameEquivalentMs = msPerCycle;
    const budget60fps = 200; // 任务书验收预算 ms
    const report = {
      网表组件数: m.netlist.components.length,
      周期数: N,
      总耗时ms: Math.round(ms * 100) / 100,
      芯片求值每周期: Math.round(perCycle),
      周期每秒: Math.round(cps),
      '帧当量(1周期)耗时ms': Math.round(frameEquivalentMs * 10000) / 10000,
      '200ms预算当量帧数': Math.round(budget60fps / frameEquivalentMs),
      '60fps帧预算(16.7ms)可跑周期数': Math.round(16.7 / msPerCycle),
    };
    console.log('BENCH_HACK', JSON.stringify(report));

    // 性能验收：帧当量 < 2ms（预算 200ms 的 1%，防 CI 抖动留大余量）
    expect(frameEquivalentMs).toBeLessThan(2);
  });

  it('ALU 黄金向量（1536 用例）对拍耗时', () => {
    const golden = loadGolden('alu') as { chip: string; kind: 'comb'; cases: { in: Record<string, number>; out: Record<string, number> }[] };
    const bench = buildChipBench(createEngine, ALU_BEHAVIOR);
    const t0 = performance.now();
    const n = runCombGolden(bench, golden);
    const ms = performance.now() - t0;
    console.log('BENCH_ALU', JSON.stringify({ 用例数: n, 耗时ms: Math.round(ms * 100) / 100, 每用例us: Math.round((ms / n) * 1000) }));
    expect(n).toBe(1536);
  });

  it('时序向量（PC 11 + RAM64 144 用例）对拍耗时', () => {
    const benchPc = buildChipBench(createEngine, PC_BEHAVIOR);
    const gPc = loadGolden('pc') as { chip: string; kind: 'clocked'; cases: { set: Record<string, number>; out: Record<string, number>; outAfter?: Record<string, number> }[] };
    const t0 = performance.now();
    const n1 = runClockedGolden(benchPc, gPc);
    const benchRam = buildChipBench(createEngine, makeRam(6));
    const gRam = loadGolden('ram64') as typeof gPc;
    const n2 = runClockedGolden(benchRam, gRam);
    const ms = performance.now() - t0;
    console.log('BENCH_SEQ', JSON.stringify({ PC用例: n1, RAM64用例: n2, 耗时ms: Math.round(ms * 100) / 100 }));
    expect(n1 + n2).toBe(155);
  });

  it('展开器：整机网表展开规模与耗时', () => {
    const t0 = performance.now();
    const flat = buildComputerNetlist({ romId: 'bench-rom', ramId: 'bench-ram', screenId: 'bench-scr' });
    const ms = performance.now() - t0;
    const byKind = new Map<string, number>();
    for (const c of flat.components) byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + 1);
    const kinds = Object.fromEntries([...byKind.entries()].sort((a, b) => b[1] - a[1]));
    console.log('BENCH_EXPAND', JSON.stringify({ 组件数: flat.components.length, 连线数: flat.wires.length, 展开耗时ms: Math.round(ms * 1000) / 1000, kinds }));
    // expand 纯函数幂等抽查：再展开一次结果一致
    const t1 = performance.now();
    const flat2 = expand(flat, {});
    void flat2;
    console.log('BENCH_EXPAND2 幂等耗时ms:', Math.round((performance.now() - t1) * 1000) / 1000);
    expect(flat.components.length).toBeGreaterThan(45);
  });

  it('芯片库清单（文档用）', () => {
    const lib = chipLibrary();
    console.log('BENCH_LIB', JSON.stringify(Object.keys(lib).sort()));
    expect(Object.keys(lib).length).toBeGreaterThanOrEqual(30);
  });
});
