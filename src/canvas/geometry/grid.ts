/**
 * 网格与吸附（M1 纯函数）
 */

import type { Pos } from '../contract.js';

/** 世界网格间距（像素） */
export const GRID = 20;

/** 把标量吸附到最近网格线（grid>0；恰好半格时远离零，保证正负对称；-0 归一化为 0） */
export function snapScalar(v: number, grid: number = GRID): number {
  if (!(grid > 0) || !Number.isFinite(v)) return v;
  const q = v / grid;
  // Math.round 半格向 +∞，这里取绝对值再补符号，实现"半格远离零"的对称语义
  const r = Math.round(Math.abs(q)) * (q < 0 ? -1 : 1);
  const out = r * grid;
  return out === 0 ? 0 : out; // 消除 -0
}

/** 把点吸附到最近网格交点 */
export function snapPos(p: Pos, grid: number = GRID): Pos {
  return { x: snapScalar(p.x, grid), y: snapScalar(p.y, grid) };
}

/** 吸附到网格（不改变语义，仅供需要“恰好网格对齐”的场景） */
export function snapDown(v: number, grid: number = GRID): number {
  if (!(grid > 0) || !Number.isFinite(v)) return v;
  return Math.floor(v / grid) * grid;
}

/** 判断值是否恰好落在网格上（浮点误差容忍 1e-6） */
export function isOnGrid(v: number, grid: number = GRID): boolean {
  if (!(grid > 0)) return false;
  const m = Math.abs(v) % grid;
  return m < 1e-6 || grid - m < 1e-6;
}
