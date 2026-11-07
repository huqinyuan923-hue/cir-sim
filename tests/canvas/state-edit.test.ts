/**
 * M4 测试 · 状态层（edits / history / doc / clipboard）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addComponent,
  addWire,
  deleteIds,
  moveComponents,
  nextComponentId,
  nextWireId,
  patchProps,
  setProps,
} from '../../src/canvas/state/edits.js';
import { History } from '../../src/canvas/state/history.js';
import { NetlistDoc } from '../../src/canvas/state/doc.js';
import {
  copySelection,
  fromClipboardText,
  pasteData,
  toClipboardText,
} from '../../src/canvas/state/clipboard.js';
import { makeSelection, toggleInSelection, unionSelection, pruneSelection } from '../../src/canvas/state/selection.js';
import type { Netlist } from '../../src/canvas/contract.js';

const EMPTY: Netlist = { components: [], wires: [] };

function sampleNetlist(): Netlist {
  return {
    components: [
      { id: 'c1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
      { id: 'c2', kind: 'AND', pos: { x: 100, y: 0 }, props: {} },
    ],
    wires: [{ id: 'w1', from: { componentId: 'c1', port: 'OUT' }, to: { componentId: 'c2', port: 'A' } }],
  };
}

describe('edits · id 推导', () => {
  it('空网表 → c1/w1', () => {
    expect(nextComponentId(EMPTY)).toBe('c1');
    expect(nextWireId(EMPTY)).toBe('w1');
  });

  it('取最大序号 +1（容忍空洞）', () => {
    const nl = sampleNetlist();
    expect(nextComponentId(nl)).toBe('c3');
    expect(nextWireId(nl)).toBe('w2');
  });

  it('非 c/w 前缀 id 不参与推导', () => {
    const nl: Netlist = {
      components: [
        { id: 'gate-9', kind: 'AND', pos: { x: 0, y: 0 }, props: {} },
        { id: 'c5', kind: 'AND', pos: { x: 0, y: 0 }, props: {} },
      ],
      wires: [{ id: 'link-x', from: { componentId: 'c5', port: 'OUT' }, to: { componentId: 'gate-9', port: 'A' } }],
    };
    expect(nextComponentId(nl)).toBe('c6');
    expect(nextWireId(nl)).toBe('w1');
  });
});

describe('edits · 不可变编辑', () => {
  it('addComponent 不改入参，生成新数组与新组件', () => {
    const nl = sampleNetlist();
    const r = addComponent(nl, 'OR', { x: 200, y: 0 });
    expect(r.id).toBe('c3');
    expect(r.netlist).not.toBe(nl);
    expect(r.netlist.components).toHaveLength(3);
    expect(nl.components).toHaveLength(2); // 原网表未变
    expect(r.netlist.components[2]!.pos).toEqual({ x: 200, y: 0 });
  });

  it('moveComponents 只移动指定组件', () => {
    const nl = sampleNetlist();
    const next = moveComponents(nl, new Set(['c1']), { x: 20, y: 20 });
    expect(next.components[0]!.pos).toEqual({ x: 20, y: 20 });
    expect(next.components[1]!.pos).toEqual({ x: 100, y: 0 });
    expect(nl.components[0]!.pos).toEqual({ x: 0, y: 0 });
  });

  it('moveComponents 零位移返回原引用', () => {
    const nl = sampleNetlist();
    expect(moveComponents(nl, new Set(['c1']), { x: 0, y: 0 })).toBe(nl);
  });

  it('deleteIds 级联删除关联连线', () => {
    const nl = sampleNetlist();
    const next = deleteIds(nl, new Set(['c1']), new Set());
    expect(next.components).toHaveLength(1);
    expect(next.wires).toHaveLength(0); // w1 连接 c1 → 级联删除
  });

  it('deleteIds 单独删线', () => {
    const nl = sampleNetlist();
    const next = deleteIds(nl, new Set(), new Set(['w1']));
    expect(next.components).toHaveLength(2);
    expect(next.wires).toHaveLength(0);
  });

  it('addWire 成功与去重（含反向重复）', () => {
    const nl = sampleNetlist();
    const r1 = addWire(nl, { componentId: 'c2', port: 'OUT' }, { componentId: 'c1', port: 'OUT' });
    // c1 没有 OUT 口——画布侧不校验端口存在性，允许（引擎诊断负责）
    expect(r1.ok).toBe(true);
    const r2 = addWire(nl, { componentId: 'c1', port: 'OUT' }, { componentId: 'c2', port: 'A' });
    expect(r2).toEqual({ ok: false, reason: 'duplicate' });
    const r3 = addWire(nl, { componentId: 'c2', port: 'A' }, { componentId: 'c1', port: 'OUT' });
    expect(r3).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('addWire 自连拒绝', () => {
    const r = addWire(EMPTY, { componentId: 'c1', port: 'OUT' }, { componentId: 'c1', port: 'OUT' });
    expect(r).toEqual({ ok: false, reason: 'self' });
  });

  it('setProps 覆盖 / patchProps 合并', () => {
    const nl = sampleNetlist();
    const s = setProps(nl, 'c1', { label: 'X' });
    expect(s.components[0]!.props).toEqual({ label: 'X' });
    const p = patchProps(s, 'c1', { bits: 4 });
    expect(p.components[0]!.props).toEqual({ label: 'X', bits: 4 });
    expect(nl.components[0]!.props).toEqual({});
  });

  it('patchProps 目标不存在返回原引用', () => {
    const nl = sampleNetlist();
    expect(patchProps(nl, 'nope', { a: 1 })).toBe(nl);
  });
});

describe('history 栈', () => {
  it('push/undo/redo 基本循环', () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    expect(h.canUndo).toBe(true);
    expect(h.undo(3)).toBe(2);
    expect(h.canRedo).toBe(true);
    expect(h.redo(2)).toBe(3);
    expect(h.canRedo).toBe(false);
  });

  it('push 作废重做栈', () => {
    const h = new History<number>();
    h.push(1);
    h.push(2);
    h.undo(3);
    h.push(9); // 作废 redo
    expect(h.canRedo).toBe(false);
    expect(h.undo(9)).toBe(9); // 最近一次 push 的快照
    expect(h.undo(2)).toBe(1);
  });

  it('空栈 undo/redo 返回 null', () => {
    const h = new History<number>();
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBeNull();
  });

  it('上限截断（limit=3，push 5 个）', () => {
    const h = new History<number>(3);
    for (const v of [1, 2, 3, 4, 5]) h.push(v);
    expect(h.depth).toBe(3);
    // 最老的 1、2 已被挤出
    expect(h.undo(6)).toBe(5);
    expect(h.undo(5)).toBe(4);
    expect(h.undo(4)).toBe(3);
    expect(h.canUndo).toBe(false);
  });
});

describe('NetlistDoc · 50 步深栈', () => {
  it('连续 50 次编辑，undo/redo 全程正确', () => {
    const doc = new NetlistDoc();
    for (let i = 0; i < 50; i++) {
      doc.addComponentAt('INPUT', { x: i * 20, y: 0 });
    }
    expect(doc.netlist.components).toHaveLength(50);
    // undo 到空
    for (let i = 0; i < 50; i++) {
      expect(doc.undo()).toBe(true);
    }
    expect(doc.netlist.components).toHaveLength(0);
    expect(doc.undo()).toBe(false);
    // redo 到满
    for (let i = 0; i < 50; i++) {
      expect(doc.redo()).toBe(true);
    }
    expect(doc.netlist.components).toHaveLength(50);
    expect(doc.redo()).toBe(false);
  });

  it('addComponentAt 选中新组件并可撤销', () => {
    const doc = new NetlistDoc();
    const id = doc.addComponentAt('AND', { x: 40, y: 40 });
    expect(doc.selection.components.has(id)).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.netlist.components).toHaveLength(0);
    expect(doc.selection.components.size).toBe(0);
  });

  it('commitMove 提交位移并清预览', () => {
    const doc = new NetlistDoc(sampleNetlist());
    doc.setSelection({ components: new Set(['c1']), wires: new Set() });
    doc.movePreview({ x: 20, y: 0 });
    expect(doc.previewDelta).toEqual({ x: 20, y: 0 });
    doc.commitMove({ x: 20, y: 0 });
    expect(doc.previewDelta).toBeNull();
    expect(doc.findComponent('c1')!.pos).toEqual({ x: 20, y: 0 });
    expect(doc.undo()).toBe(true);
    expect(doc.findComponent('c1')!.pos).toEqual({ x: 0, y: 0 });
  });

  it('cancelMove 只清预览不改网表', () => {
    const doc = new NetlistDoc(sampleNetlist());
    doc.setSelection({ components: new Set(['c1']), wires: new Set() });
    doc.movePreview({ x: 20, y: 0 });
    doc.cancelMove();
    expect(doc.previewDelta).toBeNull();
    expect(doc.findComponent('c1')!.pos).toEqual({ x: 0, y: 0 });
    expect(doc.canUndo).toBe(false);
  });

  it('addWireBetween 重复连线返回失败原因', () => {
    const doc = new NetlistDoc(sampleNetlist());
    const r1 = doc.addWireBetween({ componentId: 'c2', port: 'OUT' }, { componentId: 'c1', port: 'OUT' });
    expect(r1.ok).toBe(true);
    const r2 = doc.addWireBetween({ componentId: 'c2', port: 'OUT' }, { componentId: 'c1', port: 'OUT' });
    expect(r2).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('deleteSelection 级联并清空选择', () => {
    const doc = new NetlistDoc(sampleNetlist());
    doc.setSelection({ components: new Set(['c1']), wires: new Set() });
    doc.deleteSelection();
    expect(doc.netlist.components).toHaveLength(1);
    expect(doc.netlist.wires).toHaveLength(0);
    expect(doc.selection.components.size).toBe(0);
  });

  it('删除后拐点覆盖层同步修剪', () => {
    const doc = new NetlistDoc(sampleNetlist());
    doc.bends.set('w1', { x: 60, y: 60 });
    doc.setSelection({ components: new Set(['c1']), wires: new Set() });
    doc.deleteSelection();
    expect(doc.bends.has('w1')).toBe(false);
  });

  it('onChange 触发与退订', () => {
    const doc = new NetlistDoc();
    const spy = vi.fn();
    const off = doc.onChange(spy);
    doc.addComponentAt('AND', { x: 0, y: 0 });
    expect(spy).toHaveBeenCalled();
    off();
    spy.mockClear();
    doc.addComponentAt('AND', { x: 20, y: 0 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('剪贴板', () => {
  it('copySelection 归一化原点并深拷贝', () => {
    const nl = sampleNetlist();
    const data = copySelection(nl, { components: new Set(['c1', 'c2']), wires: new Set() });
    expect(data.components).toHaveLength(2);
    expect(data.components[0]!.pos).toEqual({ x: 0, y: 0 }); // c1 已在原点
    expect(data.components[1]!.pos).toEqual({ x: 100, y: 0 });
    expect(data.wires).toHaveLength(1); // 两端都在选中集
    // 深拷贝：改副本不影响原网表
    data.components[0]!.pos.x = 999;
    expect(nl.components[0]!.pos.x).toBe(0);
  });

  it('copySelection 只保留两端都选中的连线', () => {
    const nl = sampleNetlist();
    const data = copySelection(nl, { components: new Set(['c1']), wires: new Set() });
    expect(data.wires).toHaveLength(0);
  });

  it('pasteData 重新生成 id 并重映射连线', () => {
    const nl = sampleNetlist();
    const data = copySelection(nl, { components: new Set(['c1', 'c2']), wires: new Set() });
    const r = pasteData(data, nl, { x: 40, y: 40 });
    expect(r.netlist.components).toHaveLength(4);
    const newIds = [...r.selection.components];
    expect(newIds).toHaveLength(2);
    expect(newIds).not.toContain('c1');
    expect(newIds).not.toContain('c2');
    // 连线重映射到新 id
    const newWire = r.netlist.wires[1]!;
    expect(r.selection.wires.has(newWire.id)).toBe(true);
    expect(newWire.from.componentId).not.toBe('c1');
    expect(r.netlist.components.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('pasteData 丢弃引用缺失的连线', () => {
    const data = {
      components: [{ id: 'x1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} }],
      wires: [{ id: 'xw', from: { componentId: 'x1', port: 'OUT' }, to: { componentId: 'ghost', port: 'A' } }],
    };
    const r = pasteData(data, EMPTY, { x: 0, y: 0 });
    expect(r.netlist.wires).toHaveLength(0);
  });

  it('文本 round-trip 无损', () => {
    const nl = sampleNetlist();
    const data = copySelection(nl, { components: new Set(['c1', 'c2']), wires: new Set() });
    const text = toClipboardText(data);
    const back = fromClipboardText(text);
    expect(back).not.toBeNull();
    expect(back!.components).toEqual(data.components);
    expect(back!.wires).toEqual(data.wires);
  });

  it('fromClipboardText 拒绝异构文本与坏 JSON', () => {
    expect(fromClipboardText('hello')).toBeNull();
    expect(fromClipboardText('{"magic":"other"}')).toBeNull();
    expect(fromClipboardText('{"magic":"cir-canvas-clipboard-v1"}')).toBeNull();
    expect(fromClipboardText('not json {')).toBeNull();
  });

  it('Doc.pasteFromText 完整流程（含选中切换）', () => {
    const doc = new NetlistDoc(sampleNetlist());
    doc.setSelection({ components: new Set(['c1', 'c2']), wires: new Set() });
    const text = doc.copyToText();
    doc.setSelection({ components: new Set(), wires: new Set() });
    const n = doc.pasteFromText(text, { x: 40, y: 40 });
    expect(n).toBe(2);
    expect(doc.netlist.components).toHaveLength(4);
    expect(doc.selection.components.size).toBe(2);
    // 可撤销
    expect(doc.undo()).toBe(true);
    expect(doc.netlist.components).toHaveLength(2);
  });
});

describe('selection 工具', () => {
  it('toggle / union / prune', () => {
    let s = makeSelection(['c1'], ['w1']);
    s = toggleInSelection(s, 'component', 'c1');
    expect(s.components.size).toBe(0);
    s = toggleInSelection(s, 'component', 'c1');
    expect(s.components.has('c1')).toBe(true);
    const u = unionSelection(s, makeSelection(['c2'], []));
    expect(u.components.size).toBe(2);
    const p = pruneSelection(u, new Set(['c1']), new Set(['w1']));
    expect([...p.components]).toEqual(['c1']);
  });
});
