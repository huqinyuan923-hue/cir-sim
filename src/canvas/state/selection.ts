/**
 * 选择集（M4 的核心数据，渲染/交互共用）
 * 组件与连线分别记录 id；id 在同一 Netlist 内全局唯一（画布生成时带前缀）。
 */

export interface Selection {
  components: ReadonlySet<string>;
  wires: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = {
  components: new Set<string>(),
  wires: new Set<string>(),
};

export function isEmptySelection(s: Selection): boolean {
  return s.components.size === 0 && s.wires.size === 0;
}

export function selectionCount(s: Selection): number {
  return s.components.size + s.wires.size;
}

/** 完全替换 */
export function makeSelection(components: readonly string[], wires: readonly string[]): Selection {
  return { components: new Set(components), wires: new Set(wires) };
}

/** 切换单个 id 的选中态（shift 点击） */
export function toggleInSelection(s: Selection, kind: 'component' | 'wire', id: string): Selection {
  if (kind === 'component') {
    const next = new Set(s.components);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { components: next, wires: s.wires };
  }
  const next = new Set(s.wires);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { components: s.components, wires: next };
}

/** 并集（shift 框选） */
export function unionSelection(a: Selection, b: Selection): Selection {
  return {
    components: new Set([...a.components, ...b.components]),
    wires: new Set([...a.wires, ...b.wires]),
  };
}

/** 剔除已删除的 id（删除后修剪） */
export function pruneSelection(s: Selection, aliveComponents: ReadonlySet<string>, aliveWires: ReadonlySet<string>): Selection {
  return {
    components: new Set([...s.components].filter((id) => aliveComponents.has(id))),
    wires: new Set([...s.wires].filter((id) => aliveWires.has(id))),
  };
}

export function clearSelection(): Selection {
  return { components: new Set(), wires: new Set() };
}
