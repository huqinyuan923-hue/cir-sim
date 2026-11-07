/**
 * 视图变换（M2 的数学核心，M1 先落纯函数部分）
 * pan/zoom 统一在变换里：screen = world * zoom + pan
 */

import type { Pos } from '../contract.js';

export interface Viewport {
  /** 屏幕视口宽（CSS 像素） */
  width: number;
  /** 屏幕视口高 */
  height: number;
}

/** 缩放范围 */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 1.1;

/** 缩放钳制：NaN 回退最小值；±Infinity 由 min/max 自然钳制 */
export function clampZoom(z: number, min: number = ZOOM_MIN, max: number = ZOOM_MAX): number {
  if (Number.isNaN(z)) return min;
  return Math.min(max, Math.max(min, z));
}

/**
 * 以屏幕点 anchor 为不动点缩放：返回新 pan。
 * 约束：world(anchor) 不变 → pan' = anchor - world * zoom'
 */
export function panForZoomAt(
  anchor: Pos,
  world: Pos,
  newZoom: number,
): { x: number; y: number } {
  return { x: anchor.x - world.x * newZoom, y: anchor.y - world.y * newZoom };
}

/** 世界 → 屏幕 */
export function worldToScreen(p: Pos, pan: Pos, zoom: number): Pos {
  return { x: p.x * zoom + pan.x, y: p.y * zoom + pan.y };
}

/** 屏幕 → 世界 */
export function screenToWorld(p: Pos, pan: Pos, zoom: number): Pos {
  return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
}
