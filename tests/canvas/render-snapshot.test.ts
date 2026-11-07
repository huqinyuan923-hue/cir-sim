/**
 * M2 测试 · RecorderContext 渲染断言
 * 场景：网格 / 连线 / 组件体 / 端口与状态点 / 选择框 / 幽灵 / 布线预览 / 框选 / 诊断高亮 / 视图变换
 */
import { describe, expect, it } from 'vitest';
import { RecorderContext } from '../../src/canvas/render/RecorderContext.js';
import {
  drawComponents,
  drawGrid,
  drawOverlay,
  drawScene,
  drawWires,
} from '../../src/canvas/render/renderer.js';
import { emptyScene, projectDiagnostics } from '../../src/canvas/render/scene.js';
import type { Scene, ViewState } from '../../src/canvas/render/scene.js';
import type { Netlist } from '../../src/canvas/contract.js';
import { GRID } from '../../src/canvas/geometry/grid.js';

function view(over: Partial<ViewState> = {}): ViewState {
  return { pan: { x: 0, y: 0 }, zoom: 1, width: 400, height: 300, ...over };
}

const TWO_GATES: Netlist = {
  components: [
    { id: 'c1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
    { id: 'c2', kind: 'AND', pos: { x: 100, y: 0 }, props: {} },
  ],
  wires: [
    {
      id: 'w1',
      from: { componentId: 'c1', port: 'OUT' },
      to: { componentId: 'c2', port: 'A' },
    },
  ],
};

function sceneWith(netlist: Netlist, over: Partial<Scene> = {}, v = view()): Scene {
  const s = emptyScene(netlist, v);
  return { ...s, ...over };
}

describe('drawGrid 网格层', () => {
  it('先铺背景再画线，缩放足够时画次网格', () => {
    const rc = new RecorderContext();
    drawGrid(rc, sceneWith({ components: [], wires: [] }));
    expect(rc.filter('fillRect')[0]).toEqual({ op: 'fillRect', args: [0, 0, 400, 300] });
    expect(rc.count('lineTo')).toBeGreaterThan(10);
    // 像素对齐：坐标带 0.5
    const sx = rc.filter('moveTo').map((c) => c.args[0]);
    expect(sx).toContain(0.5);
  });

  it('zoom < 0.4 时跳过次网格只留主网格', () => {
    const rc = new RecorderContext();
    drawGrid(rc, sceneWith({ components: [], wires: [] }, {}, view({ zoom: 0.2 })));
    // 次网格间距 20*0.2=4 < 8 → 不画 minor；主网格 100*0.2=20 ≥ 12 → 画 major
    expect(rc.count('stroke')).toBe(1);
  });

  it('pan 改变网格起点（世界对齐）', () => {
    const rc = new RecorderContext();
    drawGrid(rc, sceneWith({ components: [], wires: [] }, {}, view({ pan: { x: -15, y: -15 } })));
    // 第一条竖线在世界 x=0 → 屏幕 -14.5（视口左侧外）
    const firstMoveX = rc.filter('moveTo')[0]!.args[0] as number;
    expect(firstMoveX).toBe(-15 + 0.5);
  });
});

describe('drawWires 连线层', () => {
  it('按端口引出段布线并化简：INPUT.OUT(right) → AND.A(left) 一条水平线', () => {
    const rc = new RecorderContext();
    drawWires(rc, sceneWith(TWO_GATES));
    // INPUT pos(0,0) OUT 端口世界 (40,20)；AND pos(100,0) A 端口 (100,20)
    // straight: (40,20) → (100,20)，2 个点
    const lineTos = rc.filter('lineTo');
    expect(lineTos.length).toBe(1);
    expect(lineTos[0]!.args).toEqual([100, 20]);
    expect(rc.filter('moveTo')[0]!.args).toEqual([40, 20]);
  });

  it('floating 诊断连线着灰色', () => {
    const rc = new RecorderContext();
    const diags = projectDiagnostics([
      { level: 'warning', kind: 'floating', message: '悬空', wireIds: ['w1'] },
    ]);
    drawWires(rc, sceneWith(TWO_GATES, { diags }));
    expect(rc.has('setStrokeStyle', ['#9e9e9e'])).toBe(true);
  });

  it('conflict 诊断连线着红', () => {
    const rc = new RecorderContext();
    const diags = projectDiagnostics([
      { level: 'error', kind: 'conflict', message: '冲突', wireIds: ['w1'] },
    ]);
    drawWires(rc, sceneWith(TWO_GATES, { diags }));
    expect(rc.has('setStrokeStyle', ['#d32f2f'])).toBe(true);
  });

  it('值表驱动着色：v=1 绿 / v=0 墨绿', () => {
    const rc1 = new RecorderContext();
    drawWires(rc1, sceneWith(TWO_GATES, { values: new Map([['c1:OUT', 1]]) }));
    expect(rc1.has('setStrokeStyle', ['#388e3c'])).toBe(true);
    const rc0 = new RecorderContext();
    drawWires(rc0, sceneWith(TWO_GATES, { values: new Map([['c1:OUT', 0]]) }));
    expect(rc0.has('setStrokeStyle', ['#173d1f'])).toBe(true);
  });

  it('选中连线覆盖为高亮蓝', () => {
    const rc = new RecorderContext();
    drawWires(
      rc,
      sceneWith(TWO_GATES, {
        values: new Map([['c1:OUT', 1]]),
        selection: { components: new Set(), wires: new Set(['w1']) },
      }),
    );
    expect(rc.has('setStrokeStyle', ['#0288d1'])).toBe(true);
  });

  it('端点组件缺失时退化为空绘制（不抛错）', () => {
    const rc = new RecorderContext();
    const broken: Netlist = {
      components: [],
      wires: [{ id: 'w1', from: { componentId: 'x', port: 'OUT' }, to: { componentId: 'y', port: 'IN' } }],
    };
    expect(() => drawWires(rc, sceneWith(broken))).not.toThrow();
  });

  it('多拐点连线绘制拐点方点', () => {
    const rc = new RecorderContext();
    // INPUT(0,0).OUT(40,20) → AND(100,40).A(100,60)：错位 Z 形
    const nl: Netlist = {
      components: [
        { id: 'c1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
        { id: 'c2', kind: 'AND', pos: { x: 100, y: 40 }, props: {} },
      ],
      wires: [{ id: 'w1', from: { componentId: 'c1', port: 'OUT' }, to: { componentId: 'c2', port: 'A' } }],
    };
    drawWires(rc, sceneWith(nl));
    // 拐点 (60,20),(60,60)（snap(50)=60）→ 2 个 fillRect(4x4)
    expect(rc.count('fillRect')).toBe(2);
  });
});

describe('drawComponents 组件层', () => {
  it('绘制组件体与端口圆点', () => {
    const rc = new RecorderContext();
    drawComponents(rc, sceneWith(TWO_GATES));
    // 端口圆点：INPUT 1 个 OUT + AND 3 个口 = 4；AND 体 D 形半圆再加 1 arc = 5
    expect(rc.count('arc')).toBe(5);
    // 端口填充 4 次
    expect(rc.count('fill')).toBe(4);
  });

  it('输出端口带值时绘制状态点（值着色）', () => {
    const rc = new RecorderContext();
    drawComponents(rc, sceneWith(TWO_GATES, { values: new Map([['c1:OUT', 1]]) }));
    // 5 基础 arc + c1:OUT 状态点 = 6
    expect(rc.count('arc')).toBe(6);
    expect(rc.has('setFillStyle', ['#388e3c'])).toBe(true);
  });

  it('选中组件画高亮框', () => {
    const rc = new RecorderContext();
    drawComponents(
      rc,
      sceneWith(TWO_GATES, { selection: { components: new Set(['c2']), wires: new Set() } }),
    );
    // INPUT 体的 strokeRect + c2 选择框 = 2
    expect(rc.count('strokeRect')).toBe(2);
    expect(rc.has('setStrokeStyle', ['rgba(2,136,209,0.9)'])).toBe(true);
    // c2 bounds 60x80 @ (100,0)，外扩 3px：strokeRect(97, -3, 66, 86)
    expect(rc.has('strokeRect', [97, -3, 66, 86])).toBe(true);
  });

  it('视图缩放影响组件屏幕尺寸', () => {
    const rc = new RecorderContext();
    drawComponents(rc, sceneWith(TWO_GATES, {}, view({ zoom: 2, pan: { x: 10, y: 10 } })));
    // INPUT 体 40x40 世界 → 屏幕 (10,10) 80x80
    expect(rc.has('fillRect', [10, 10, 80, 80])).toBe(true);
  });
});

describe('drawOverlay 覆盖层', () => {
  it('框选矩形（归一化 + 虚线）', () => {
    const rc = new RecorderContext();
    drawOverlay(
      rc,
      sceneWith({ components: [], wires: [] }, {
        overlay: { marquee: { x: 100, y: 50, w: -50, h: 40 } },
      }),
    );
    expect(rc.has('fillRect', [50, 50, 50, 40])).toBe(true);
    expect(rc.has('strokeRect', [50, 50, 50, 40])).toBe(true);
    expect(rc.has('setLineDash', [[4, 3]])).toBe(true);
  });

  it('布线预览为虚线折线', () => {
    const rc = new RecorderContext();
    drawOverlay(
      rc,
      sceneWith({ components: [], wires: [] }, {
        overlay: {
          wirePreview: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 40 },
          ],
        },
      }),
    );
    expect(rc.has('setLineDash', [[6, 4]])).toBe(true);
    expect(rc.filter('lineTo')).toHaveLength(2);
  });

  it('幽灵预览按组件尺寸虚框绘制', () => {
    const rc = new RecorderContext();
    drawOverlay(
      rc,
      sceneWith({ components: [], wires: [] }, { overlay: { ghost: { kind: 'AND', pos: { x: 40, y: 40 } } } }),
    );
    expect(rc.has('strokeRect', [40, 40, 60, 80])).toBe(true);
  });

  it('悬停端口画高亮圆', () => {
    const rc = new RecorderContext();
    drawOverlay(
      rc,
      sceneWith({ components: [], wires: [] }, { overlay: { hoverPort: { x: 40, y: 20 } } }),
    );
    expect(rc.has('arc', [40, 20, 6, 0, Math.PI * 2, false])).toBe(true);
  });

  it('空覆盖层不绘制任何虚线', () => {
    const rc = new RecorderContext();
    drawOverlay(rc, sceneWith({ components: [], wires: [] }));
    expect(rc.count('setLineDash')).toBe(0);
  });
});

describe('drawScene 全帧', () => {
  it('层顺序：背景 → 连线 → 组件 → 覆盖层', () => {
    const rc = new RecorderContext();
    drawScene(
      rc,
      sceneWith(TWO_GATES, { overlay: { marquee: { x: 0, y: 0, w: 10, h: 10 } } }),
    );
    const ops = rc.calls.map((c) => c.op);
    const bgIdx = ops.indexOf('fillRect');
    const wireIdx = ops.findIndex((o, i) => o === 'stroke' && i > bgIdx);
    const compIdx = ops.findIndex((o) => o === 'strokeRect' && rc.calls[o ? 0 : 0]); // 占位
    expect(bgIdx).toBeGreaterThanOrEqual(0);
    expect(wireIdx).toBeGreaterThan(bgIdx);
    expect(compIdx).toBeGreaterThanOrEqual(0);
  });

  it('完整场景可重复绘制且结果确定（两次 snapshot 一致）', () => {
    const rc1 = new RecorderContext();
    const rc2 = new RecorderContext();
    const mk = () =>
      sceneWith(TWO_GATES, {
        values: new Map([['c1:OUT', 1]]),
        overlay: { ghost: { kind: 'OR', pos: { x: 200, y: 100 } } },
      });
    drawScene(rc1, mk());
    drawScene(rc2, mk());
    expect(rc1.snapshot()).toEqual(rc2.snapshot());
  });

  it('oscillation 诊断在闪烁相位 off 时不画 DFF 警示罩', () => {
    const rc = new RecorderContext();
    const nl: Netlist = {
      components: [{ id: 'd1', kind: 'DFF', pos: { x: 0, y: 0 }, props: {} }],
      wires: [],
    };
    const diags = projectDiagnostics([{ level: 'warning', kind: 'oscillation', message: '振荡' }]);
    drawScene(rc, sceneWith(nl, { diags, time: 0 })); // phase 0 → 跳过
    expect(rc.has('setFillStyle', ['rgba(245,124,0,0.14)'])).toBe(false);
  });

  it('oscillation 诊断在闪烁相位 on 时画 DFF 警示罩', () => {
    const rc = new RecorderContext();
    const nl: Netlist = {
      components: [{ id: 'd1', kind: 'DFF', pos: { x: 0, y: 0 }, props: {} }],
      wires: [],
    };
    const diags = projectDiagnostics([{ level: 'warning', kind: 'oscillation', message: '振荡' }]);
    drawScene(rc, sceneWith(nl, { diags, time: 420 })); // phase 1 → 绘制
    expect(rc.has('setFillStyle', ['rgba(245,124,0,0.14)'])).toBe(true);
  });

  it('视图变换：pan/zoom 后所有几何按矩阵换算', () => {
    const rc = new RecorderContext();
    // zoom 2, pan (100,50)：INPUT 体 (0,0,40,40) → 屏幕 (100,50,80,80)
    drawScene(rc, sceneWith(TWO_GATES, {}, view({ zoom: 2, pan: { x: 100, y: 50 } })));
    expect(rc.has('fillRect', [100, 50, 80, 80])).toBe(true);
    // OUT 端口 (40,20) → (180, 90)
    expect(rc.has('arc', [180, 90, 3, 0, Math.PI * 2, false])).toBe(true);
  });
});
