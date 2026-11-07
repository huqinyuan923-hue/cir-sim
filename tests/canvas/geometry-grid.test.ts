/**
 * M1 几何测试 · 网格吸附
 */
import { describe, expect, it } from 'vitest';
import { GRID, isOnGrid, snapDown, snapPos, snapScalar } from '../../src/canvas/geometry/grid.js';
import { rectFromPoints } from '../../src/canvas/geometry/types.js';

describe('snapScalar 标量吸附', () => {
  it('整数格点不变', () => {
    expect(snapScalar(0)).toBe(0);
    expect(snapScalar(20)).toBe(20);
    expect(snapScalar(-40)).toBe(-40);
  });

  it('常规四舍五入', () => {
    expect(snapScalar(9)).toBe(0);
    expect(snapScalar(10)).toBe(20); // 恰好半格，远离零
    expect(snapScalar(11)).toBe(20);
    expect(snapScalar(29)).toBe(20);
    expect(snapScalar(30)).toBe(40); // 半格向上
    expect(snapScalar(31)).toBe(40);
  });

  it('负数对称', () => {
    expect(snapScalar(-9)).toBe(0);
    expect(snapScalar(-10)).toBe(-20);
    expect(snapScalar(-11)).toBe(-20);
    expect(snapScalar(-29)).toBe(-20);
    expect(snapScalar(-30)).toBe(-40);
  });

  it('自定义网格间距', () => {
    expect(snapScalar(7, 5)).toBe(5);
    expect(snapScalar(2, 5)).toBe(0);
    expect(snapScalar(-3, 5)).toBe(-5);
    expect(snapScalar(13, 10)).toBe(10);
  });

  it('grid<=0 原样返回', () => {
    expect(snapScalar(13, 0)).toBe(13);
    expect(snapScalar(13, -5)).toBe(13);
  });

  it('非有限输入原样返回', () => {
    expect(snapScalar(NaN)).toBeNaN();
    expect(snapScalar(Infinity)).toBe(Infinity);
    expect(snapScalar(-Infinity)).toBe(-Infinity);
  });

  it('极大值不崩（正确吸附到最近格点）', () => {
    const big = 1e12 + 7;
    // 1e12+7 的最近 20 倍格点：7 < 10 → 向下取 1e12
    expect(snapScalar(big)).toBe(1e12);
    expect(snapScalar(1e12 + 11)).toBe(1e12 + 20); // 11 ≥ 10 → 向上
  });
});

describe('snapPos 点吸附', () => {
  it('双轴独立吸附', () => {
    expect(snapPos({ x: 11, y: 29 })).toEqual({ x: 20, y: 20 });
    expect(snapPos({ x: -1, y: 1 })).toEqual({ x: 0, y: 0 });
  });

  it('已对齐点不变（引用新对象但值相同）', () => {
    expect(snapPos({ x: 40, y: -20 })).toEqual({ x: 40, y: -20 });
  });

  it('自定义间距', () => {
    expect(snapPos({ x: 12, y: 13 }, 10)).toEqual({ x: 10, y: 10 });
  });

  it('grid=0 退化为恒等', () => {
    expect(snapPos({ x: 3.7, y: -8.2 }, 0)).toEqual({ x: 3.7, y: -8.2 });
  });
});

describe('snapDown 向下取整吸附', () => {
  it('常规', () => {
    expect(snapDown(39, 20)).toBe(20);
    expect(snapDown(20, 20)).toBe(20);
    expect(snapDown(-1, 20)).toBe(-20);
    expect(snapDown(0, 20)).toBe(0);
  });

  it('grid<=0 / 非有限 恒等', () => {
    expect(snapDown(5, 0)).toBe(5);
    expect(snapDown(NaN, 20)).toBeNaN();
  });
});

describe('isOnGrid 网格对齐判断', () => {
  it('格点为真', () => {
    expect(isOnGrid(0)).toBe(true);
    expect(isOnGrid(20)).toBe(true);
    expect(isOnGrid(-100)).toBe(true);
  });

  it('非格点为假', () => {
    expect(isOnGrid(10)).toBe(false);
    expect(isOnGrid(10.5)).toBe(false);
    expect(isOnGrid(-3)).toBe(false);
  });

  it('grid<=0 恒假', () => {
    expect(isOnGrid(20, 0)).toBe(false);
    expect(isOnGrid(20, -20)).toBe(false);
  });
});

describe('GRID 常量与 rectFromPoints', () => {
  it('网格为 20', () => {
    expect(GRID).toBe(20);
  });

  it('rectFromPoints 任意方向归一化', () => {
    expect(rectFromPoints({ x: 30, y: 50 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      w: 20,
      h: 30,
    });
    expect(rectFromPoints({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
