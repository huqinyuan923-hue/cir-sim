/**
 * NetlistDoc —— 画布文档（M4 核心）
 * 持有当前 Netlist / 选择集 / 拐点覆盖层 / 预览状态，
 * 所有提交式编辑走历史栈；预览（拖拽中）不落历史。
 */

import type { Netlist, Pos, PortRef } from '../contract.js';
import {
  addComponent,
  addWire,
  deleteIds,
  moveComponents,
  patchProps,
  setProps,
} from './edits.js';
import { History } from './history.js';
import {
  clearSelection,
  makeSelection,
  pruneSelection,
  type Selection,
} from './selection.js';
import {
  copySelection,
  fromClipboardText,
  pasteData,
  toClipboardText,
  type ClipboardData,
} from './clipboard.js';

export interface DocListener {
  (): void;
}

export class NetlistDoc {
  netlist: Netlist;
  selection: Selection = { components: new Set(), wires: new Set() };
  /** 连线拐点覆盖层（画布侧数据，随删除修剪） */
  readonly bends: Map<string, Pos> = new Map();
  /** 拖拽预览增量（渲染专用，不落历史） */
  previewDelta: Pos | null = null;
  /** 拐点拖拽预览 */
  bendPreview: { wireId: string; pos: Pos } | null = null;

  private readonly history = new History<Netlist>(100);
  private readonly listeners = new Set<DocListener>();

  constructor(netlist: Netlist = { components: [], wires: [] }) {
    this.netlist = netlist;
  }

  /* ------------------------------ 订阅 ------------------------------ */

  onChange(listener: DocListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /* ---------------------------- 历史与提交 ---------------------------- */

  /** 提交新网表（推历史） */
  commit(next: Netlist): void {
    this.history.push(this.netlist);
    this.netlist = next;
    this.selection = pruneSelection(this.selection, aliveComponents(next), aliveWires(next));
    this.pruneBends();
    this.emit();
  }

  undo(): boolean {
    const prev = this.history.undo(this.netlist);
    if (prev === null) return false;
    this.netlist = prev;
    this.selection = pruneSelection(this.selection, aliveComponents(prev), aliveWires(prev));
    this.pruneBends();
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.netlist);
    if (next === null) return false;
    this.netlist = next;
    this.selection = pruneSelection(this.selection, aliveComponents(next), aliveWires(next));
    this.pruneBends();
    this.emit();
    return true;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  private pruneBends(): void {
    const wireIds = new Set(this.netlist.wires.map((w) => w.id));
    for (const id of [...this.bends.keys()]) {
      if (!wireIds.has(id)) this.bends.delete(id);
    }
  }

  /* ------------------------------ 编辑 ------------------------------ */

  addComponentAt(kind: string, pos: Pos): string {
    const { netlist, id } = addComponent(this.netlist, kind, pos);
    this.commit(netlist);
    // 新组件入选中
    this.selection = makeSelection([id], []);
    this.emit();
    return id;
  }

  deleteSelection(): void {
    if (this.selection.components.size === 0 && this.selection.wires.size === 0) return;
    this.commit(deleteIds(this.netlist, this.selection.components, this.selection.wires));
    this.selection = clearSelection();
  }

  /** 提交移动（拖拽结束） */
  commitMove(delta: Pos): void {
    this.previewDelta = null;
    if (delta.x === 0 && delta.y === 0) return;
    this.commit(moveComponents(this.netlist, this.selection.components, delta));
  }

  cancelMove(): void {
    this.previewDelta = null;
    this.emit();
  }

  /** 开始移动预览 */
  movePreview(delta: Pos): void {
    this.previewDelta = delta;
    this.emit();
  }

  /** 提交连线拐点 */
  commitBend(wireId: string, pos: Pos): void {
    this.bendPreview = null;
    this.bends.set(wireId, pos);
    this.emit();
  }

  cancelBend(): void {
    this.bendPreview = null;
    this.emit();
  }

  bendPreviewAt(wireId: string, pos: Pos): void {
    this.bendPreview = { wireId, pos };
    this.emit();
  }

  /** 布线提交；成功返回连线 id，失败返回原因 */
  addWireBetween(from: PortRef, to: PortRef): { ok: true; id: string } | { ok: false; reason: 'duplicate' | 'self' } {
    const r = addWire(this.netlist, from, to);
    if (!r.ok) return r;
    this.commit(r.netlist);
    this.selection = makeSelection([], [r.id]);
    this.emit();
    return { ok: true, id: r.id };
  }

  setComponentProps(id: string, props: Record<string, number | string>): void {
    this.commit(setProps(this.netlist, id, props));
  }

  patchComponentProps(id: string, patch: Record<string, number | string>): void {
    this.commit(patchProps(this.netlist, id, patch));
  }

  setSelection(selection: Selection): void {
    this.selection = selection;
    this.emit();
  }

  /* ---------------------------- 剪贴板 ---------------------------- */

  copyToText(): string {
    return toClipboardText(copySelection(this.netlist, this.selection));
  }

  copyData(): ClipboardData {
    return copySelection(this.netlist, this.selection);
  }

  /** 从文本粘贴；成功返回新选中数，失败返回 -1 */
  pasteFromText(text: string, offset: Pos = { x: 40, y: 40 }): number {
    const data = fromClipboardText(text);
    if (!data || data.components.length === 0) return -1;
    const { netlist, selection } = pasteData(data, this.netlist, offset);
    this.commit(netlist);
    this.selection = selection;
    this.emit();
    return selection.components.size;
  }

  pasteData(d: ClipboardData, offset: Pos = { x: 40, y: 40 }): number {
    if (d.components.length === 0) return -1;
    const { netlist, selection } = pasteData(d, this.netlist, offset);
    this.commit(netlist);
    this.selection = selection;
    this.emit();
    return selection.components.size;
  }

  /* ------------------------------ 查询 ------------------------------ */

  findComponent(id: string) {
    return this.netlist.components.find((c) => c.id === id) ?? null;
  }
}

function aliveComponents(nl: Netlist): ReadonlySet<string> {
  return new Set(nl.components.map((c) => c.id));
}

function aliveWires(nl: Netlist): ReadonlySet<string> {
  return new Set(nl.wires.map((w) => w.id));
}
