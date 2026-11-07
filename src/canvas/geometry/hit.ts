/**
 * 命中测试（M1 纯函数）
 * 全部返回布尔/距离，不依赖 DOM；容差以世界像素计（调用方按 zoom 折算）。
 */

import type { Pos } from '../contract.js';
import type { Rect } from './types.js';
import { rectFromPoints, normalizeRect } from './types.js';

/** 点是否在矩形内（含边界，r 先归一化） */
export function pointInRect(p: Pos, r: Rect): boolean {
  const n = normalizeRect(r);
  return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
}

/** 两矩形是否相交（边贴边视为相交） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  const na = normalizeRect(a);
  const nb = normalizeRect(b);
  return (
    na.x <= nb.x + nb.w &&
    na.x + na.w >= nb.x &&
    na.y <= nb.y + nb.h &&
    na.y + na.h >= nb.y
  );
}

/** 矩形 A 是否完全包含矩形 B（含边界） */
export function rectContainsRect(a: Rect, b: Rect): boolean {
  const na = normalizeRect(a);
  const nb = normalizeRect(b);
  return (
    nb.x >= na.x &&
    nb.y >= na.y &&
    nb.x + nb.w <= na.x + na.w &&
    nb.y + nb.h <= na.y + na.h
  );
}

/** 点到线段的最近距离（经典向量投影，端点收敛保证正确） */
export function pointSegmentDistance(p: Pos, a: Pos, b: Pos): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y); // 退化线段
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** 点到折线的最近距离（逐段取最小） */
export function pointPolylineDistance(p: Pos, pts: readonly Pos[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const d = pointSegmentDistance(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** 折线命中：距离 ≤ tol 即命中 */
export function polylineHit(pts: readonly Pos[], p: Pos, tol: number): boolean {
  return pointPolylineDistance(p, pts) <= tol;
}

/** 组件包围盒：pos 为左上角（网格对齐），尺寸由调用方给出 */
export function componentBounds(
  pos: Pos,
  w: number,
  h: number,
): Rect {
  return { x: pos.x, y: pos.y, w, h };
}

/** 框选相交测试：组件矩形与框有交集即选中 */
export function rectSelectsComponent(marquee: Rect, compRect: Rect): boolean {
  return rectsIntersect(marquee, compRect);
}

/** 折线的包围盒（用于框选连线与整体包围盒） */
export function polylineBounds(pts: readonly Pos[]): Rect {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = pts[0]!.x;
  let maxX = minX;
  let minY = pts[0]!.y;
  let maxY = minY;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return rectFromPoints({ x: minX, y: minY }, { x: maxX, y: maxY });
}

/** 依据端点端口位置求折线（调用 route），供框选/命中统一入口 */
export function wirePolylineBounds(pts: readonly Pos[]): Rect {
  return polylineBounds(pts);
}

/** 圆形命中（端口命中用） */
export function pointInCircle(p: Pos, c: Pos, radius: number): boolean {
  return Math.hypot(p.x - c.x, p.y - c.y) <= radius;
}
