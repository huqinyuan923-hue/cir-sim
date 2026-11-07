/**
 * Controller —— 画布应用粘合层
 * 指针事件 → 世界坐标 → FSM；FSM 动作 → NetlistDoc 编辑；
 * Scene 组装 → 渲染器（rAF 按需重绘，振荡闪烁时持续重绘）；
 * 文档变更 → 引擎同步 + localStorage 自动保存；键盘快捷键全集。
 */

import type { Pos, Wire } from '../contract.js';
import type { Rect, Dir } from '../geometry/types.js';
import { rectFromPoints, normalizeRect } from '../geometry/types.js';
import { CanvasAdapter } from '../render/CanvasAdapter.js';
import { drawScene } from '../render/renderer.js';
import { projectDiagnostics } from '../render/scene.js';
import type { CanvasOverlay, Scene, ViewState } from '../render/scene.js';
import type { FsmAction, FsmQuery, FsmState, HitPort } from '../interact/fsm.js';
import { initialFsmState, transition } from '../interact/fsm.js';
import { NetlistDoc } from '../state/doc.js';
import type { SimController } from '../sim/SimController.js';
import { componentBoundsOf, portPos, portsOf, portStubDir, listShapeKinds } from '../model/shapes.js';
import { wirePolyline } from '../geometry/wirepath.js';
import { pointInRect, polylineBounds, rectsIntersect } from '../geometry/hit.js';
import { snapPos, GRID } from '../geometry/grid.js';
import { CanvasView } from './CanvasView.js';
import type { PointerEventInfo } from './CanvasView.js';
import { saveLocal } from '../io/fileio.js';
import { applyPreviewDelta } from '../state/edits.js';
import { unionSelection } from '../state/selection.js';
import type { Selection } from '../state/selection.js';
import { routeOrthogonal } from '../geometry/route.js';

/** 控制器对外钩子（UI 面板刷新） */
export interface ControllerHooks {
  onStatus(message: string): void;
  onSelectionChanged(): void;
  onToolChanged(kind: string | null): void;
  onSimEvent(): void;
}

/** 工具选择哨兵（快捷键 1 = 选择工具） */
export const SELECT_TOOL = '__select__';

export class Controller implements FsmQuery {
  readonly doc: NetlistDoc;
  readonly sim: SimController;
  readonly view: CanvasView;
  private hooks: ControllerHooks;
  private fsm: FsmState = initialFsmState();
  private hoverPort: Pos | null = null;
  private dirty = true;
  private rafId: number | null = null;
  private spaceHeld = false;
  private lastCopyText = '';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(doc: NetlistDoc, sim: SimController, view: CanvasView, hooks: ControllerHooks) {
    this.doc = doc;
    this.sim = sim;
    this.view = view;
    this.hooks = hooks;
    this.bindKeyboard();
    this.bindCanvasView();

    doc.onChange(() => {
      this.syncEngine();
      this.scheduleSave();
      this.invalidate();
      this.hooks.onSelectionChanged();
    });
    sim.onChange(() => {
      this.invalidate();
      this.hooks.onSimEvent();
    });

    this.syncEngine();

    const loop = (): void => {
      if (this.disposed) return;
      if (this.dirty || this.oscillating()) {
        this.render();
        this.dirty = false;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.sim.dispose();
  }

  /* ------------------------------ FSM 查询实现 ------------------------------ */

  get selection(): Selection {
    return this.doc.selection;
  }

  portAt(pos: Pos): HitPort | null {
    for (const comp of this.doc.netlist.components) {
      for (const entry of portsOf(comp)) {
        if (Math.hypot(entry.pos.x - pos.x, entry.pos.y - pos.y) <= 6) {
          return { componentId: comp.id, port: entry.port.name, pos: entry.pos };
        }
      }
    }
    return null;
  }

  componentAt(pos: Pos) {
    for (const comp of this.doc.netlist.components) {
      if (pointInRect(pos, componentBoundsOf(comp))) return comp;
    }
    return null;
  }

  wireAt(pos: Pos): Wire | null {
    for (const w of this.doc.netlist.wires) {
      const pts = wirePolyline(this.doc.netlist, w, this.doc.bends);
      if (pts.length >= 2 && distToPolyline(pos, pts) <= 5) return w;
    }
    return null;
  }

  /* ------------------------------ 事件入口 ------------------------------ */

  onPointerDown(e: PointerEventInfo): void {
    this.dispatch({
      type: 'mousedown',
      pos: snapPos(e.world),
      button: e.button,
      shift: e.shift,
    });
  }

  onPointerMove(e: PointerEventInfo): void {
    this.dispatch({ type: 'mousemove', pos: snapPos(e.world), shift: e.shift });
  }

  onPointerUp(e: PointerEventInfo): void {
    this.dispatch({ type: 'mouseup', pos: snapPos(e.world), button: e.button, shift: e.shift });
  }

  onDoubleClick(e: PointerEventInfo): void {
    this.dispatch({ type: 'dblclick', pos: snapPos(e.world) });
  }

  onWheel(factor: number, screenPos: Pos): void {
    this.view.zoomAt(screenPos, factor);
    this.invalidate();
  }

  onResize(): void {
    this.invalidate();
  }

  onViewChanged(): void {
    this.invalidate();
  }

  isPanMode(): boolean {
    return this.spaceHeld;
  }

  /* ------------------------------ 状态机驱动 ------------------------------ */

  get fsmState(): FsmState {
    return this.fsm;
  }

  setTool(kind: string | null): void {
    this.dispatch({ type: 'setTool', kind });
    this.hooks.onToolChanged(kind);
  }

  private dispatch(event: Parameters<typeof transition>[1]): void {
    const result = transition(this.fsm, event, this);
    this.fsm = result.state;
    for (const action of result.actions) this.handleAction(action);
    this.invalidate();
  }

  /* ------------------------------ 动作处理 ------------------------------ */

  private handleAction(action: FsmAction): void {
    switch (action.type) {
      case 'select':
        this.doc.setSelection(action.selection);
        break;
      case 'hover':
        this.hoverPort = action.pos;
        break;
      case 'beginDrag':
        break; // 预览不落历史，无需快照
      case 'place':
        this.doc.addComponentAt(action.kind, action.pos);
        break;
      case 'movePreview':
        this.doc.movePreview(action.delta);
        break;
      case 'commitMove':
        this.doc.commitMove(action.delta);
        break;
      case 'cancelMove':
        this.doc.cancelMove();
        break;
      case 'bendPreview': {
        const wireId = this.currentWireDragId();
        if (wireId) this.doc.bendPreviewAt(wireId, action.pos);
        break;
      }
      case 'commitBend': {
        const wireId = this.currentWireDragId();
        if (wireId) this.doc.commitBend(wireId, action.pos);
        break;
      }
      case 'cancelBend':
        this.doc.cancelBend();
        break;
      case 'commitWire': {
        const r = this.doc.addWireBetween(action.from, action.to);
        if (!r.ok) {
          const why = r.reason === 'duplicate' ? '连线已存在' : '不能自连';
          this.hooks.onStatus('布线失败：' + why);
        }
        break;
      }
      case 'commitMarquee':
        this.applyMarquee(action.rect, action.additive);
        break;
      case 'click': {
        if (action.kind === 'component') {
          const comp = this.doc.findComponent(action.id);
          if (comp && comp.kind === 'INPUT') {
            this.sim.toggleInput(comp.id);
            this.sim.tick();
          }
        }
        break;
      }
      case 'status':
        this.hooks.onStatus(action.message);
        break;
    }
  }

  private currentWireDragId(): string | null {
    if (this.fsm.name === 'dragging' && this.fsm.target === 'wire' && this.fsm.clicked) {
      return this.fsm.clicked.id;
    }
    return null;
  }

  /** 框选：相交即选中；additive 与既有选择取并集 */
  private applyMarquee(rectUnnormalized: Rect, additive: boolean): void {
    const rect = normalizeRect(rectUnnormalized);
    const compIds: string[] = [];
    const wireIds: string[] = [];
    for (const comp of this.doc.netlist.components) {
      if (rectsIntersect(rect, componentBoundsOf(comp))) compIds.push(comp.id);
    }
    for (const w of this.doc.netlist.wires) {
      const pts = wirePolyline(this.doc.netlist, w, this.doc.bends);
      if (pts.length >= 2 && rectsIntersect(rect, polylineBounds(pts))) wireIds.push(w.id);
    }
    const base: Selection = additive ? this.doc.selection : { components: new Set(), wires: new Set() };
    const next = unionSelection(base, { components: new Set(compIds), wires: new Set(wireIds) });
    this.doc.setSelection(next);
  }

  /* ------------------------------ 场景与渲染 ------------------------------ */

  private oscillating(): boolean {
    return this.sim.diagnostics().some((d) => d.kind === 'oscillation');
  }

  private buildOverlay(): CanvasOverlay {
    const overlay: CanvasOverlay = {};
    if (this.fsm.name === 'placing') {
      overlay.ghost = { kind: this.fsm.kind, pos: { x: this.fsm.ghost.x, y: this.fsm.ghost.y } };
    }
    if (this.fsm.name === 'wiring') {
      const fromComp = this.doc.findComponent(this.fsm.from.componentId);
      if (fromComp) {
        const fromPos = portPos(fromComp, this.fsm.from.port);
        if (fromPos) {
          const dir = portStubDir(fromComp.kind, this.fsm.from.port) ?? 'right';
          const cursor = snapPos(this.fsm.cursor);
          overlay.wirePreview = routeOrthogonal(fromPos, dir, cursor, nearestDir(fromPos, cursor));
        }
      }
    }
    if (this.fsm.name === 'marquee') {
      overlay.marquee = rectFromPoints(this.fsm.start, this.fsm.current);
    }
    if (this.hoverPort) {
      overlay.hoverPort = { x: this.hoverPort.x, y: this.hoverPort.y };
    }
    return overlay;
  }

  render(): void {
    const rc = new CanvasAdapter(this.view.rawContext);
    const effective = applyPreviewDelta(this.doc.netlist, this.doc.selection.components, this.doc.previewDelta);
    const bends = this.doc.bendPreview
      ? new Map([...this.doc.bends, [this.doc.bendPreview.wireId, this.doc.bendPreview.pos]])
      : this.doc.bends;
    const scene: Scene = {
      netlist: effective,
      selection: this.doc.selection,
      values: this.sim.values,
      diags: projectDiagnostics(this.sim.diagnostics()),
      overlay: this.buildOverlay(),
      view: {
        pan: this.view.pan,
        zoom: this.view.zoom,
        width: this.view.width,
        height: this.view.height,
      },
      bends,
      time: Date.now(),
    };
    this.dirty = false;
    drawScene(rc, scene);
  }

  private invalidate(): void {
    this.dirty = true;
  }

  /* ------------------------------ 引擎同步与自动保存 ------------------------------ */

  private syncEngine(): void {
    this.sim.setNetlistRef(this.doc.netlist);
    this.sim.syncNetlist(this.doc.netlist);
    this.sim.tick();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveLocal(this.doc.netlist);
      this.saveTimer = null;
    }, 500);
  }

  /* ------------------------------ 键盘快捷键 ------------------------------ */

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (isFormField) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.code === 'Space' && !e.repeat) {
        this.spaceHeld = true;
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        this.dispatch({ type: 'cancel' });
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.doc.undo();
        return;
      }
      if ((ctrl && e.key.toLowerCase() === 'y') || (ctrl && e.shiftKey && e.key.toLowerCase() === 'z')) {
        e.preventDefault();
        this.doc.redo();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this.lastCopyText = this.doc.copyToText();
        writeSystemClipboard(this.lastCopyText);
        this.hooks.onStatus('已复制 ' + this.doc.selection.components.size + ' 个组件');
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'x') {
        e.preventDefault();
        this.lastCopyText = this.doc.copyToText();
        writeSystemClipboard(this.lastCopyText);
        this.doc.deleteSelection();
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        if (this.lastCopyText) {
          const n = this.doc.pasteFromText(this.lastCopyText, gridOffset());
          const msg = n >= 0 ? '已粘贴 ' + n + ' 个组件' : '剪贴板为空';
          this.hooks.onStatus(msg);
        }
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const text = this.doc.copyToText();
        const n = this.doc.pasteFromText(text, gridOffset());
        const msg = n >= 0 ? '已创建副本 ' + n + ' 个' : '无选中内容';
        this.hooks.onStatus(msg);
        return;
      }
      if (ctrl && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.doc.setSelection({
          components: new Set(this.doc.netlist.components.map((c) => c.id)),
          wires: new Set(this.doc.netlist.wires.map((w) => w.id)),
        });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.doc.deleteSelection();
        return;
      }
      if (e.key === '+' || e.key === '=') {
        this.view.setZoomAtCenter(this.view.zoom * 1.2);
        this.invalidate();
        return;
      }
      if (e.key === '-') {
        this.view.setZoomAtCenter(this.view.zoom / 1.2);
        this.invalidate();
        return;
      }
      if (singleDigit(e.key)) {
        const idx = Number(e.key);
        const kinds = toolKindsList();
        const kind = kinds[idx - 1] ?? SELECT_TOOL;
        this.setTool(kind === SELECT_TOOL ? null : kind);
        return;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceHeld = false;
      }
    });
  }

  /* ------------------------------ 画布绑定 ------------------------------ */

  private bindCanvasView(): void {
    this.view.attach({
      onPointerDown: (e) => this.onPointerDown(e),
      onPointerMove: (e) => this.onPointerMove(e),
      onPointerUp: (e) => this.onPointerUp(e),
      onDoubleClick: (e) => this.onDoubleClick(e),
      onWheel: (f, s) => this.onWheel(f, s),
      onResize: () => this.onResize(),
      onViewChanged: () => this.invalidate(),
      isPanMode: () => this.isPanMode(),
    });
  }
}

/* ------------------------------ 文件级辅助 ------------------------------ */

function distToPolyline(p: Pos, pts: readonly Pos[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

function nearestDir(from: Pos, to: Pos): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
}

function gridOffset(): Pos {
  return { x: 2 * GRID, y: 2 * GRID };
}

function writeSystemClipboard(text: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {
    /* 无剪贴板权限时静默 */
  }
}

function singleDigit(key: string): boolean {
  return key.length === 1 && key >= '1' && key <= '9';
}

/** 工具清单：索引 1 = 选择工具，2..9 = 组件 kind（与注册表顺序一致） */
function toolKindsList(): string[] {
  return [SELECT_TOOL, ...listShapeKinds()];
}
