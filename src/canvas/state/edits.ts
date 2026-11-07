/**
 * Netlist 不可变编辑（M4）
 * "网表即真相"：画布操作全部落为对 Netlist 的不可变编辑，
 * 每个函数返回新 Netlist（浅拷贝 + 按需替换涉及的条目），绝不改入参。
 */

import type { ComponentInstance, Netlist, Pos, PortRef, Wire } from '../contract.js';

/** 从现有网表推导下一个可用组件 id（c{n}，取最大 n+1） */
export function nextComponentId(nl: Netlist): string {
  let max = 0;
  for (const c of nl.components) {
    const m = c.id.match(/^c(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

/** 下一个可用连线 id（w{n}） */
export function nextWireId(nl: Netlist): string {
  let max = 0;
  for (const w of nl.wires) {
    const m = w.id.match(/^w(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `w${max + 1}`;
}

export interface AddComponentResult {
  netlist: Netlist;
  id: string;
}

/** 添加组件 */
export function addComponent(
  nl: Netlist,
  kind: string,
  pos: Pos,
  props: Record<string, number | string> = {},
): AddComponentResult {
  const id = nextComponentId(nl);
  const comp: ComponentInstance = { id, kind, pos: { ...pos }, props: { ...props } };
  return { netlist: { components: [...nl.components, comp], wires: nl.wires }, id };
}

/** 平移指定组件（delta 必须已吸附） */
export function moveComponents(nl: Netlist, ids: ReadonlySet<string>, delta: Pos): Netlist {
  if (delta.x === 0 && delta.y === 0) return nl;
  return {
    components: nl.components.map((c) =>
      ids.has(c.id) ? { ...c, pos: { ...c.pos, x: c.pos.x + delta.x, y: c.pos.y + delta.y } } : c,
    ),
    wires: nl.wires,
  };
}

/** 删除组件与连线（级联删除连接到被删组件的线） */
export function deleteIds(nl: Netlist, componentIds: ReadonlySet<string>, wireIds: ReadonlySet<string>): Netlist {
  return {
    components: nl.components.filter((c) => !componentIds.has(c.id)),
    wires: nl.wires.filter(
      (w) => !wireIds.has(w.id) && !componentIds.has(w.from.componentId) && !componentIds.has(w.to.componentId),
    ),
  };
}

export type AddWireResult =
  | { ok: true; netlist: Netlist; id: string }
  | { ok: false; reason: 'duplicate' | 'self' };

/** 添加连线（同端口 / 重复线被拒绝） */
export function addWire(nl: Netlist, from: PortRef, to: PortRef): AddWireResult {
  if (from.componentId === to.componentId && from.port === to.port) {
    return { ok: false, reason: 'self' };
  }
  const dup = nl.wires.some(
    (w) =>
      (sameRef(w.from, from) && sameRef(w.to, to)) || (sameRef(w.from, to) && sameRef(w.to, from)),
  );
  if (dup) return { ok: false, reason: 'duplicate' };
  const id = nextWireId(nl);
  const wire: Wire = { id, from: { ...from }, to: { ...to } };
  return { ok: true, netlist: { components: nl.components, wires: [...nl.wires, wire] }, id };
}

function sameRef(a: PortRef, b: PortRef): boolean {
  return a.componentId === b.componentId && a.port === b.port;
}

/** 覆盖组件属性（保留未提及的键时请先读旧 props 再传入） */
export function setProps(nl: Netlist, id: string, props: Record<string, number | string>): Netlist {
  return {
    components: nl.components.map((c) => (c.id === id ? { ...c, props: { ...props } } : c)),
    wires: nl.wires,
  };
}

/** 修改单项属性（合并语义） */
export function patchProps(
  nl: Netlist,
  id: string,
  patch: Record<string, number | string>,
): Netlist {
  const comp = nl.components.find((c) => c.id === id);
  if (!comp) return nl;
  return setProps(nl, id, { ...comp.props, ...patch });
}

/** 应用拖拽预览：生成"临时平移后的网表"（不落历史，仅供渲染） */
export function applyPreviewDelta(nl: Netlist, ids: ReadonlySet<string>, delta: Pos | null): Netlist {
  if (!delta || (delta.x === 0 && delta.y === 0)) return nl;
  return moveComponents(nl, ids, delta);
}

/** 端口引用等价 */
export function samePortRef(a: PortRef, b: PortRef): boolean {
  return a.componentId === b.componentId && a.port === b.port;
}
