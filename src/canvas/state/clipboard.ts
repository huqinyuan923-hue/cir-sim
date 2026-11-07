/**
 * 剪贴板（M4）
 * 复制 = 选中集深度拷贝 + 原点归一化；粘贴 = 重新生成 id、重映射连线、丢弃悬空引用。
 * 文本形式可走系统剪贴板（round-trip 无损）。
 */

import type { ComponentInstance, Netlist, Wire } from '../contract.js';
import type { Selection } from './selection.js';
import { nextComponentId, nextWireId } from './edits.js';

export interface ClipboardData {
  components: ComponentInstance[];
  wires: Wire[];
}

const CLIPBOARD_MAGIC = 'cir-canvas-clipboard-v1';

/** 复制选中集（组件 + 两端都在选中集内的连线），原点归一化到 (0,0) */
export function copySelection(nl: Netlist, sel: Selection): ClipboardData {
  const comps = nl.components.filter((c) => sel.components.has(c.id));
  const idSet = new Set(comps.map((c) => c.id));
  const wires = nl.wires.filter((w) => idSet.has(w.from.componentId) && idSet.has(w.to.componentId));
  if (comps.length === 0) return { components: [], wires: [] };
  let minX = Infinity;
  let minY = Infinity;
  for (const c of comps) {
    if (c.pos.x < minX) minX = c.pos.x;
    if (c.pos.y < minY) minY = c.pos.y;
  }
  return {
    components: comps.map((c) => ({ ...structuredClone(c), pos: { x: c.pos.x - minX, y: c.pos.y - minY } })),
    wires: structuredClone(wires),
  };
}

export interface PasteResult {
  netlist: Netlist;
  selection: Selection;
}

/** 粘贴：重新生成全部 id，重映射连线；引用缺失的线被丢弃 */
export function pasteData(data: ClipboardData, nl: Netlist, offset: { x: number; y: number }): PasteResult {
  const idMap = new Map<string, string>();
  let components = [...nl.components];
  for (const c of data.components) {
    const newId = nextComponentId({ components, wires: [] });
    idMap.set(c.id, newId);
    components = [
      ...components,
      {
        id: newId,
        kind: c.kind,
        pos: { x: c.pos.x + offset.x, y: c.pos.y + offset.y },
        props: { ...c.props },
      },
    ];
  }
  const wires: Wire[] = [];
  for (const w of data.wires) {
    const from = idMap.get(w.from.componentId);
    const to = idMap.get(w.to.componentId);
    if (!from || !to) continue; // 引用缺失：丢弃
    wires.push({ id: nextWireId({ components, wires }), from: { componentId: from, port: w.from.port }, to: { componentId: to, port: w.to.port } });
  }
  const netlist: Netlist = { components, wires: [...nl.wires, ...wires] };
  return {
    netlist,
    selection: {
      components: new Set(idMap.values()),
      wires: new Set(wires.map((w) => w.id)),
    },
  };
}

/** 序列化为文本（系统剪贴板可用；含 magic 头供识别） */
export function toClipboardText(data: ClipboardData): string {
  return JSON.stringify({ magic: CLIPBOARD_MAGIC, ...data });
}

/** 从文本解析剪贴板数据（非本应用格式返回 null） */
export function fromClipboardText(text: string): ClipboardData | null {
  try {
    const obj = JSON.parse(text) as { magic?: string; components?: ComponentInstance[]; wires?: Wire[] };
    if (obj.magic !== CLIPBOARD_MAGIC) return null;
    if (!Array.isArray(obj.components) || !Array.isArray(obj.wires)) return null;
    return { components: obj.components, wires: obj.wires };
  } catch {
    return null;
  }
}
