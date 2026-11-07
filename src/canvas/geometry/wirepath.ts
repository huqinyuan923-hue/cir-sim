/**
 * 连线路径推导：契约 Wire 只记录两端 PortRef（无几何），
 * 折线由端口位置 + 端口方位 + 可选拐点覆盖层共同决定。
 * 命中测试 / 渲染 / 框选共用本模块，保证"所见即所测"。
 *
 * 性能：网表不可变（编辑即换引用），组件索引与整表路由按 Netlist 引用缓存
 * （WeakMap），1k 组件级场景的每帧重绘避免重复推导。
 */

import type { ComponentInstance, Netlist, Pos, Wire } from '../contract.js';
import { routeOrthogonal } from './route.js';
import { portPos, portStubDir } from '../model/shapes.js';

/** 折线拐点覆盖层（画布侧装饰数据，不属于契约 Netlist） */
export type BendOverlay = ReadonlyMap<string, Pos>;

/** 端口引用键（值表/诊断共用） */
export function portKey(componentId: string, port: string): string {
  return componentId + ':' + port;
}

/** 组件索引缓存（Netlist 不可变 → 引用即缓存键） */
const compIndexCache = new WeakMap<Netlist, Map<string, ComponentInstance>>();

function compIndexOf(nl: Netlist): Map<string, ComponentInstance> {
  return compIndexCache.get(nl) ?? buildIndex(nl);
}

function buildIndex(nl: Netlist): Map<string, ComponentInstance> {
  const m = new Map<string, ComponentInstance>();
  for (const c of nl.components) m.set(c.id, c);
  compIndexCache.set(nl, m);
  return m;
}

/** 找组件（索引缓存，O(1)） */
export function findComponent(nl: Netlist, id: string) {
  return compIndexOf(nl).get(id) ?? null;
}

/** 整表路由缓存：仅当无拐点覆盖时启用 */
const routeCache = new WeakMap<Netlist, Map<string, Pos[]>>();

/**
 * 计算一条连线在当前 Netlist 下的折线。
 * 端点组件缺失或端口未知时返回兜底直线（画布仍可画，诊断会提示）。
 */
export function wirePolyline(nl: Netlist, wire: Wire, bends?: BendOverlay): Pos[] {
  if (bends === undefined || bends.size === 0) {
    const cached = routeCache.get(nl)?.get(wire.id);
    if (cached) return cached;
  }
  const index = compIndexOf(nl);
  const from = index.get(wire.from.componentId);
  const on = index.get(wire.to.componentId);
  const to = on;
  let pts: Pos[];
  const a = from ? portPos(from, wire.from.port) : null;
  const b = to ? portPos(to, wire.to.port) : null;
  if (!from || !to || !a || !b) {
    pts = straightFallback(from, to);
  } else {
    const dirA = portStubDir(from.kind, wire.from.port) ?? 'right';
    const dirB = portStubDir(to.kind, wire.to.port) ?? 'left';
    pts = routeOrthogonal(a, dirA, b, dirB, bends?.get(wire.id));
  }
  if (bends === undefined || bends.size === 0) {
    let m = routeCache.get(nl);
    if (m === undefined) {
      m = new Map();
      routeCache.set(nl, m);
    }
    m.set(wire.id, pts);
  }
  return pts;
}

function straightFallback(from: ComponentInstance | undefined, to: ComponentInstance | undefined): Pos[] {
  if (!from || !to) return [];
  return [
    { x: from.pos.x, y: from.pos.y },
    { x: to.pos.x, y: to.pos.y },
  ];
}

/** 批量计算全部连线折线（整表渲染入口，带缓存） */
export function allWirePolylines(nl: Netlist, bends?: BendOverlay): Map<string, Pos[]> {
  if (bends === undefined || bends.size === 0) {
    const cached = routeCache.get(nl);
    if (cached !== undefined && cached.size >= nl.wires.length) return cached;
  }
  const map = new Map<string, Pos[]>();
  for (const w of nl.wires) map.set(w.id, wirePolyline(nl, w, bends));
  return map;
}
