/**
 * M1 几何测试 · 正交布线
 */
import { describe, expect, it } from 'vitest';
import {
  STUB,
  isOrthogonal,
  orthoMid,
  orthoViaWaypoint,
  polylineLength,
  routeOrthogonal,
  simplifyPolyline,
  stubEnd,
} from '../../src/canvas/geometry/route.js';
import type { Pos } from '../../src/canvas/contract.js';
import { pointPolylineDistance } from '../../src/canvas/geometry/hit.js';

describe('stubEnd 引出段', () => {
  it('四个方向', () => {
    const p: Pos = { x: 100, y: 100 };
    expect(stubEnd(p, 'right')).toEqual({ x: 120, y: 100 });
    expect(stubEnd(p, 'left')).toEqual({ x: 80, y: 100 });
    expect(stubEnd(p, 'up')).toEqual({ x: 100, y: 80 });
    expect(stubEnd(p, 'down')).toEqual({ x: 100, y: 120 });
  });

  it('自定义长度', () => {
    expect(stubEnd({ x: 0, y: 0 }, 'right', 5)).toEqual({ x: 5, y: 0 });
    expect(stubEnd({ x: 0, y: 0 }, 'left', 0)).toEqual({ x: 0, y: 0 });
  });

  it('STUB 常量为 20', () => {
    expect(STUB).toBe(20);
  });
});

describe('orthoMid 两点正交中段', () => {
  it('同行直连（无中间点）', () => {
    expect(orthoMid({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual([]);
  });

  it('同列直连', () => {
    expect(orthoMid({ x: 40, y: 0 }, { x: 40, y: 80 })).toEqual([]);
  });

  it('前进方向 H-V-H（中点 x=50 吸附到 60：半格远离零）', () => {
    const mid = orthoMid({ x: 0, y: 0 }, { x: 100, y: 60 });
    expect(mid).toEqual([
      { x: 60, y: 0 },
      { x: 60, y: 60 },
    ]);
  });

  it('前进方向中点 x 吸附到网格', () => {
    const mid = orthoMid({ x: 0, y: 0 }, { x: 50, y: 40 }, 20);
    expect(mid[0]!.x).toBe(20); // 25 → 20
  });

  it('回绕方向 V-H-V', () => {
    const mid = orthoMid({ x: 100, y: 0 }, { x: 0, y: 60 });
    expect(mid).toEqual([
      { x: 100, y: 40 },
      { x: 0, y: 40 },
    ]);
  });

  it('回绕中点 y 吸附', () => {
    const mid = orthoMid({ x: 100, y: 0 }, { x: 0, y: 50 }, 20);
    expect(mid[0]!.y).toBe(20); // 25 → 20
  });

  it('负坐标（中点 -50 半格远离零 → -60）', () => {
    const mid = orthoMid({ x: -100, y: -60 }, { x: 0, y: 0 });
    expect(mid).toEqual([
      { x: -60, y: -60 },
      { x: -60, y: 0 },
    ]);
  });

  it('间距小于 2 格时仍产生合法正交路径', () => {
    const mid = orthoMid({ x: 0, y: 0 }, { x: 20, y: 20 });
    // s.x < t.x → H-V-H；midX=10 → 吸附 20
    expect(mid.every((p) => p.x === 20 || p.y === 0 || p.y === 20)).toBe(true);
    expect(mid).toEqual([
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ]);
  });
});

describe('orthoViaWaypoint', () => {
  it('阶梯三段，精确穿过 waypoint', () => {
    expect(
      orthoViaWaypoint({ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 60, y: 20 }),
    ).toEqual([
      { x: 60, y: 0 },
      { x: 60, y: 20 },
      { x: 100, y: 20 },
    ]);
  });

  it('waypoint 吸附到网格', () => {
    const mid = orthoViaWaypoint({ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 63, y: 21 });
    expect(mid[1]).toEqual({ x: 60, y: 20 });
  });
});

describe('simplifyPolyline', () => {
  it('合并共线水平段', () => {
    const out = simplifyPolyline([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  it('合并共线垂直段', () => {
    const out = simplifyPolyline([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 0, y: 100 },
    ]);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ]);
  });

  it('保留拐点', () => {
    const out = simplifyPolyline([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ]);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ]);
  });

  it('去重连续重复点', () => {
    const out = simplifyPolyline([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]);
  });

  it('来回重叠段保留拐点（U 形回绕）', () => {
    const out = simplifyPolyline([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ]);
    expect(out).toHaveLength(4);
  });

  it('空与单点', () => {
    expect(simplifyPolyline([])).toEqual([]);
    expect(simplifyPolyline([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
  });

  it('两点直连不变', () => {
    expect(
      simplifyPolyline([
        { x: 0, y: 0 },
        { x: 0, y: 30 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 30 },
    ]);
  });

  it('锯齿多拐点全部保留', () => {
    const zigzag = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 40 },
      { x: 60, y: 40 },
    ];
    expect(simplifyPolyline(zigzag)).toEqual(zigzag);
  });
});

describe('routeOrthogonal 完整布线', () => {
  it('同一直线：out→in 正对', () => {
    const pts = routeOrthogonal(
      { x: 0, y: 0 },
      'right',
      { x: 100, y: 0 },
      'left',
    );
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(isOrthogonal(pts)).toBe(true);
  });

  it('错位：Z 形三段', () => {
    const pts = routeOrthogonal(
      { x: 0, y: 0 },
      'right',
      { x: 100, y: 40 },
      'left',
    );
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 40 },
      { x: 100, y: 40 },
    ]);
    expect(isOrthogonal(pts)).toBe(true);
  });

  it('首点是端口 a，末点是端口 b', () => {
    const pts = routeOrthogonal({ x: 0, y: 0 }, 'right', { x: 80, y: 0 }, 'left');
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 80, y: 0 });
  });

  it('回绕（b 在 a 左侧）绕行', () => {
    const pts = routeOrthogonal({ x: 100, y: 0 }, 'right', { x: 0, y: 40 }, 'left');
    // s=(120,0) t=(-20,40)：回绕 V-H-V
    expect(isOrthogonal(pts)).toBe(true);
    expect(pts[0]).toEqual({ x: 100, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 0, y: 40 });
    expect(pts.length).toBeGreaterThanOrEqual(5);
  });

  it('带 waypoint（路径精确穿过拐点）', () => {
    const wp: Pos = { x: 60, y: 100 };
    const pts = routeOrthogonal(
      { x: 0, y: 0 },
      'right',
      { x: 100, y: 40 },
      'left',
      wp,
    );
    expect(isOrthogonal(pts)).toBe(true);
    // 折线精确穿过 waypoint（点在折线上，距离为 0）
    expect(pointPolylineDistance(wp, pts)).toBe(0);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 100, y: 40 });
  });

  it('同点退化', () => {
    expect(routeOrthogonal({ x: 40, y: 40 }, 'right', { x: 40, y: 40 }, 'left')).toEqual([
      { x: 40, y: 40 },
    ]);
  });

  it('垂直方向端口（up/down 引出）', () => {
    const pts = routeOrthogonal({ x: 0, y: 0 }, 'down', { x: 40, y: 100 }, 'up');
    expect(isOrthogonal(pts)).toBe(true);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 40, y: 100 });
    expect(pts[1]).toEqual({ x: 0, y: 20 }); // down 引出段
  });

  it('曼哈顿长度不超过 1.5 倍直线参考（防绕远）', () => {
    const pts = routeOrthogonal({ x: 0, y: 0 }, 'right', { x: 200, y: 60 }, 'left');
    const len = polylineLength(pts);
    expect(len).toBeLessThanOrEqual(1.5 * (200 + 60) + 2 * STUB);
  });

  it('负坐标布线保持正交', () => {
    const pts = routeOrthogonal({ x: -100, y: -40 }, 'right', { x: -20, y: 40 }, 'left');
    expect(isOrthogonal(pts)).toBe(true);
    expect(pts[0]).toEqual({ x: -100, y: -40 });
    expect(pts[pts.length - 1]).toEqual({ x: -20, y: 40 });
  });
});

describe('polylineLength / isOrthogonal', () => {
  it('曼哈顿长度', () => {
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 40 },
      ]),
    ).toBe(70);
  });

  it('单点长度 0', () => {
    expect(polylineLength([{ x: 1, y: 2 }])).toBe(0);
  });

  it('isOrthogonal 拒绝对角段', () => {
    expect(
      isOrthogonal([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(false);
    expect(
      isOrthogonal([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe(true);
    expect(isOrthogonal([])).toBe(true);
  });
});
