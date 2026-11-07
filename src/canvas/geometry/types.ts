/**
 * 几何基础类型与纯函数（M1）
 */

import type { Pos } from '../contract.js';

/** 矩形（世界坐标），w/h 可为负，使用前先 normalizeRect */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 正交方向（端口引出方向） */
export type Dir = 'up' | 'down' | 'left' | 'right';

/** 方向单位向量表 */
export const DIR_VEC: Readonly<Record<Dir, Pos>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/** 方向取反 */
export function dirReverse(d: Dir): Dir {
  if (d === 'up') return 'down';
  if (d === 'down') return 'up';
  if (d === 'left') return 'right';
  return 'left';
}

/** 把任意两点归一化为 w/h 非负的矩形 */
export function rectFromPoints(a: Pos, b: Pos): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** 矩形归一化（w/h 非负） */
export function normalizeRect(r: Rect): Rect {
  return {
    x: r.w >= 0 ? r.x : r.x + r.w,
    y: r.h >= 0 ? r.y : r.y + r.h,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** 两点取整吸附辅助：返回中点（四舍五入） */
export function midOf(a: Pos, b: Pos): Pos {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}
