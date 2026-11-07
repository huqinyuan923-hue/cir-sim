/**
 * M6 性能基准：1k 组件场景一次完整 drawScene 的耗时。
 * 验收门禁：中位数 < 8ms（RecorderContext 统计绘制调用规模）。
 */
import { describe, expect, it } from 'vitest';
import { RecorderContext } from '../../src/canvas/render/RecorderContext.js';
import { drawScene } from '../../src/canvas/render/renderer.js';
import { projectDiagnostics } from '../../src/canvas/render/scene.js';
import type { Scene } from '../../src/canvas/render/scene.js';
import { MockEngine } from '../../src/canvas/mock/MockEngine.js';
import type { Netlist } from '../../src/canvas/contract.js';

/** 生成 1k INPUT + 1k AND + 2k 连线的链式电路网表 */
function bigNetlist(): Netlist {
  const N = 1000;
  const components: Netlist['components'] = [];
  const wires: Netlist['wires'] = [];
  const perRow = 25;
  for (let i = 1; i <= N; i++) {
    const col = (i - 1) % perRow;
    const row = Math.floor((i - 1) / perRow);
    const x = col * 80;
    const y = row * 120;
    components.push({ id: 'c' + i, kind: 'INPUT', pos: { x, y }, props: {} });
    components.push({ id: 'g' + i, kind: 'AND', pos: { x: x + 80, y: y + 20 }, props: {} });
    wires.push({
      id: 'w' + i,
      from: { componentId: 'c' + i, port: 'OUT' },
      to: { componentId: 'g' + i, port: 'A' },
    });
    wires.push({
      id: 'v' + i,
      from: { componentId: 'g' + i, port: 'OUT' },
      to: { componentId: 'c' + i, port: 'OUT' },
    });
  }
  return { components, wires };
}

function buildScene(): Scene {
  const nl = bigNetlist();
  const engine = new MockEngine();
  engine.load(nl);
  engine.tick();
  const values = new Map<string, number>();
  for (const c of nl.components) {
    values.set(c.id + ':OUT', engine.read({ componentId: c.id, port: 'OUT' }));
  }
  const scene: Scene = {
    netlist: nl,
    selection: { components: new Set(['c1', 'g2']), wires: new Set(['w1']) },
    values,
    diags: projectDiagnostics(engine.diagnostics()),
    overlay: { marquee: { x: 0, y: 0, w: 100, h: 100 } },
    view: { pan: { x: 0, y: 0 }, zoom: 0.75, width: 1600, height: 1200 },
    bends: new Map(),
    time: 420,
  };
  return scene;
}

describe('性能基准', () => {
  it(
    '1k 组件 drawScene 中位数 < 8ms',
    { timeout: 120000 },
    () => {
      const scene = buildScene();
      const warm = new RecorderContext();
      drawScene(warm, scene); // 预热（JIT / 内联缓存）
      drawScene(warm, scene);
      const times: number[] = [];
      const RUNS = 30;
      for (let i = 0; i < RUNS; i++) {
        const rc = freshRc();
        const t0 = performance.now();
        drawScene(rc, scene);
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(RUNS / 2)]!;
      const p90 = times[Math.floor(RUNS * 0.9)]!;
      const worst = times[RUNS - 1]!;
      console.log(
        'bench: median=%s ms | p90=%s ms | max=%s ms | calls(1 frame)=%s',
        median.toFixed(3),
        p90.toFixed(3),
        worst.toFixed(3),
        warm.calls.length,
      );
      expect(median).toBeLessThan(8);
    },
  );
});

function freshRc(): RecorderContext {
  return new RecorderContext();
}
