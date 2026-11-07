/**
 * 正交（曼哈顿）布线（M1 纯函数）
 *
 * 连线形状完全由端点端口位置 + 端口方向（+ 可选拐点）推导：
 * - 两端各伸出一小段"引出段"（stub），方向 = 端口朝向；
 * - 中段在两 stub 末端之间做正交连接；
 * - 提供 waypoint（用户拖拽出的拐点）时以其为中间骨架；
 * - 最后 simplifyPolyline 合并共线段、删除零长段。
 */

import type { Pos } from '../contract.js';
import type { Dir } from './types.js';
import { DIR_VEC, midOf } from './types.js';
import { snapScalar, snapPos } from './grid.js';

/** 引出段长度（世界像素），恰好一格 */
export const STUB = 20;

/** 端口朝向 → 引出段末端（引出段方向 = 信号流出方向） */
export function stubEnd(port: Pos, dir: Dir, stub: number = STUB): Pos {
  const v = DIR_VEC[dir];
  return { x: port.x + v.x * stub, y: port.y + v.y * stub };
}

/**
 * 两点间正交中段：s → t 的折线（不含 s/t 本身之外的额外端点）。
 * - 同行/同列：直连；
 * - s 在 t 左侧（前进方向）：H-V-H，竖直段放在中点 x；
 * - s 在 t 右侧（回绕）：V-H-V，水平段放在中点 y。
 */
export function orthoMid(s: Pos, t: Pos, grid: number = 20): Pos[] {
  if (s.y === t.y || s.x === t.x) return [];
  if (s.x < t.x) {
    const midX = snapScalar((s.x + t.x) / 2, grid);
    return [
      { x: midX, y: s.y },
      { x: midX, y: t.y },
    ];
  }
  const midY = snapScalar((s.y + t.y) / 2, grid);
  return [
    { x: s.x, y: midY },
    { x: t.x, y: midY },
  ];
}

/**
 * 过 waypoint 的中段：s → (wp.x, s.y) → wp → (t.x, wp.y) → t。
 * 折线保证精确穿过 wp（用户拖拽拐点所见即所得）。
 */
export function orthoViaWaypoint(s: Pos, t: Pos, wp: Pos): Pos[] {
  const w = snapPos(wp);
  return [
    { x: w.x, y: s.y },
    w,
    { x: t.x, y: w.y },
  ];
}

/**
 * 完整布线：a(方向 dirA) → b(方向 dirB)，可选中途 waypoint。
 * 返回折线点列（a 为首点，b 为末点），已化简。
 */
export function routeOrthogonal(
  a: Pos,
  dirA: Dir,
  b: Pos,
  dirB: Dir,
  waypoint?: Pos,
  grid: number = 20,
): Pos[] {
  if (a.x === b.x && a.y === b.y) return [a]; // 同点：退化
  const s = stubEnd(a, dirA, STUB);
  const t = stubEnd(b, dirB, STUB);
  const mid = waypoint !== undefined ? orthoViaWaypoint(s, t, waypoint) : orthoMid(s, t, grid);
  return simplifyPolyline([a, s, ...mid, t, b]);
}

/**
 * 折线化简：
 * 1) 去重连续重复点；
 * 2) 合并共线（同一水平/垂直线上的相邻段）；
 * 3) 去除零长段。
 * 输入至少保留首末两点（空输入返回空）。
 */
export function simplifyPolyline(pts: readonly Pos[]): Pos[] {
  const out: Pos[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue; // 去重
    out.push(p);
  }
  // 合并共线：若 prev->cur 与 cur->next 同方向（水平或垂直），删 cur
  for (let i = 1; i + 1 < out.length; ) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    const next = out[i + 1]!;
    const horiz = prev.y === cur.y && cur.y === next.y;
    const vert = prev.x === cur.x && cur.x === next.x;
    if (horiz || vert) {
      out.splice(i, 1);
    } else {
      i++;
    }
  }
  // 去除零长段（化简后理论上已无，防御性保留）
  const out2: Pos[] = [];
  for (const p of out) {
    const last = out2[out2.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out2.push(p);
  }
  return out2;
}

/** 折线总长度（用于诊断/测试） */
export function polylineLength(pts: readonly Pos[]): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    total += Math.abs(b.x - a.x) + Math.abs(b.y - a.y); // 正交折线，曼哈顿长度精确
  }
  return total;
}

/** 判断折线是否严格正交（每段水平或垂直） */
export function isOrthogonal(pts: readonly Pos[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (a.x !== b.x && a.y !== b.y) return false;
  }
  return true;
}

/** 中点吸附（供外部需要时使用） */
export const snapMid = midOf;
