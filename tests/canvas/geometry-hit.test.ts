/**
 * M1 几何测试 · 命中测试（矩形/线段/折线/圆）
 */
import { describe, expect, it } from 'vitest';
import {
  pointInRect,
  pointInCircle,
  pointPolylineDistance,
  pointSegmentDistance,
  polylineBounds,
  polylineHit,
  rectContainsRect,
  rectsIntersect,
} from '../../src/canvas/geometry/hit.js';
import { normalizeRect } from '../../src/canvas/geometry/types.js';

describe('pointInRect', () => {
  const r = { x: 10, y: 10, w: 20, h: 10 };

  it('内部点命中', () => {
    expect(pointInRect({ x: 20, y: 15 }, r)).toBe(true);
  });

  it('四角命中（含边界）', () => {
    expect(pointInRect({ x: 10, y: 10 }, r)).toBe(true);
    expect(pointInRect({ x: 30, y: 10 }, r)).toBe(true);
    expect(pointInRect({ x: 10, y: 20 }, r)).toBe(true);
    expect(pointInRect({ x: 30, y: 20 }, r)).toBe(true);
  });

  it('边外一点不命中', () => {
    expect(pointInRect({ x: 9.999, y: 15 }, r)).toBe(false);
    expect(pointInRect({ x: 30.001, y: 15 }, r)).toBe(false);
    expect(pointInRect({ x: 20, y: 9.999 }, r)).toBe(false);
    expect(pointInRect({ x: 20, y: 20.001 }, r)).toBe(false);
  });

  it('负 w/h 矩形先归一化再判', () => {
    expect(pointInRect({ x: 20, y: 15 }, { x: 30, y: 20, w: -20, h: -10 })).toBe(true);
    expect(pointInRect({ x: 5, y: 5 }, { x: 30, y: 20, w: -20, h: -10 })).toBe(false);
  });

  it('零尺寸矩形只含自身', () => {
    expect(pointInRect({ x: 5, y: 5 }, { x: 5, y: 5, w: 0, h: 0 })).toBe(true);
    expect(pointInRect({ x: 5.1, y: 5 }, { x: 5, y: 5, w: 0, h: 0 })).toBe(false);
  });
});

describe('rectsIntersect', () => {
  it('普通相交', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it('分离不相交', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('边贴边视为相交', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: -10, w: 10, h: 10 })).toBe(true);
  });

  it('包含关系为相交', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 40, y: 40, w: 2, h: 2 })).toBe(true);
  });

  it('仅一角相触', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 10, h: 10 })).toBe(true);
  });

  it('负尺寸归一化后相交', () => {
    expect(rectsIntersect({ x: 10, y: 10, w: -10, h: -10 }, { x: 5, y: 5, w: 3, h: 3 })).toBe(true);
  });

  it('零尺寸与线接触', () => {
    expect(rectsIntersect({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect({ x: 5, y: 15.1, w: 0, h: 0 }, { x: 0, y: 5, w: 10, h: 10 })).toBe(false);
  });
});

describe('rectContainsRect', () => {
  it('包含', () => {
    expect(rectContainsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 5, h: 5 })).toBe(true);
  });

  it('相等也算包含', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectContainsRect(r, r)).toBe(true);
  });

  it('溢出边界不包含', () => {
    expect(rectContainsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 2, w: 5, h: 5 })).toBe(false);
    expect(rectContainsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: -1, y: 2, w: 5, h: 5 })).toBe(false);
  });

  it('负尺寸归一化', () => {
    expect(rectContainsRect({ x: 10, y: 10, w: -10, h: -10 }, { x: 5, y: 5, w: 2, h: 2 })).toBe(true);
  });
});

describe('normalizeRect', () => {
  it('负宽高翻转', () => {
    expect(normalizeRect({ x: 30, y: 20, w: -10, h: -5 })).toEqual({ x: 20, y: 15, w: 10, h: 5 });
  });

  it('正尺寸不变', () => {
    expect(normalizeRect({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('pointSegmentDistance', () => {
  it('垂足在段内', () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
  });

  it('垂足在段外收敛到端点', () => {
    expect(pointSegmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(pointSegmentDistance({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
  });

  it('端点距离为零', () => {
    expect(pointSegmentDistance({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(pointSegmentDistance({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });

  it('退化线段（两点重合）', () => {
    expect(pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it('斜线段', () => {
    // 段 (0,0)-(4,4)，点 (1,3)：垂足 (2,2)，距离 sqrt(2)
    expect(pointSegmentDistance({ x: 1, y: 3 }, { x: 0, y: 0 }, { x: 4, y: 4 })).toBeCloseTo(Math.SQRT2, 10);
  });
});

describe('pointPolylineDistance / polylineHit', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it('各段最近距离', () => {
    expect(pointPolylineDistance({ x: 5, y: 2 }, L)).toBe(2);
    expect(pointPolylineDistance({ x: 12, y: 5 }, L)).toBe(2);
  });

  it('拐点附近取两段最小', () => {
    // 点 (12,-1) 距两段最近点均为拐点 (10,0)：√5
    expect(pointPolylineDistance({ x: 12, y: -1 }, L)).toBeCloseTo(Math.sqrt(5), 10);
  });

  it('空折线无穷远', () => {
    expect(pointPolylineDistance({ x: 0, y: 0 }, [])).toBe(Infinity);
  });

  it('单点折线', () => {
    expect(pointPolylineDistance({ x: 3, y: 4 }, [{ x: 0, y: 0 }])).toBe(5);
  });

  it('polylineHit 容差边界（≤ 判定）', () => {
    expect(polylineHit(L, { x: 5, y: 5 }, 5)).toBe(true); // 恰好 5 → 命中
    expect(polylineHit(L, { x: 0, y: 5.001 }, 5)).toBe(false); // 5.001 > 5 → 不命中
    expect(polylineHit(L, { x: 5, y: 5 }, 4.9)).toBe(false);
  });

  it('polylineHit 容差 0 仅线上点', () => {
    expect(polylineHit(L, { x: 5, y: 0 }, 0)).toBe(true);
    expect(polylineHit(L, { x: 5, y: 0.001 }, 0)).toBe(false);
  });
});

describe('pointInCircle', () => {
  it('圆内/圆上/圆外', () => {
    const c = { x: 0, y: 0 };
    expect(pointInCircle({ x: 3, y: 4 }, c, 5)).toBe(true);
    expect(pointInCircle({ x: 5, y: 0 }, c, 5)).toBe(true);
    expect(pointInCircle({ x: 5.001, y: 0 }, c, 5)).toBe(false);
  });

  it('零半径', () => {
    expect(pointInCircle({ x: 1, y: 1 }, { x: 1, y: 1 }, 0)).toBe(true);
    expect(pointInCircle({ x: 1, y: 2 }, { x: 1, y: 1 }, 0)).toBe(false);
  });
});

describe('polylineBounds', () => {
  it('L 形折线包围盒', () => {
    const L = [
      { x: 20, y: 40 },
      { x: 100, y: 40 },
      { x: 100, y: 120 },
    ];
    expect(polylineBounds(L)).toEqual({ x: 20, y: 40, w: 80, h: 80 });
  });

  it('单点包围盒为零', () => {
    expect(polylineBounds([{ x: 5, y: 7 }])).toEqual({ x: 5, y: 7, w: 0, h: 0 });
  });

  it('空折线返回零矩形', () => {
    expect(polylineBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('负坐标', () => {
    const L = [
      { x: -30, y: -10 },
      { x: -10, y: -10 },
    ];
    expect(polylineBounds(L)).toEqual({ x: -30, y: -10, w: 20, h: 0 });
  });
});
