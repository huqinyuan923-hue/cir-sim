/**
 * 交互状态机（M3）
 *
 * 五状态：idle / placing(组件幽灵) / dragging(移动选区或拖拽连线拐点) /
 *         wiring(两点布线) / marquee(框选)。
 *
 * 设计要点：
 * - 状态机与渲染/文档完全解耦：`transition(state, event, query)` 为纯函数，
 *   返回新状态与"动作列表"，由控制器（controller.ts）对文档/渲染执行；
 * - `query` 是只读的世界查询接口（命中测试/选择集/吸附），测试可注入桩；
 * - 非法转移一律拒绝：状态不变、不产生变更动作（部分拒绝附带 status 提示）；
 * - 鼠标坐标均为世界坐标（控制器先做 screenToWorld）。
 */

import type { ComponentInstance, Pos, PortRef, Wire } from '../contract.js';
import type { Rect } from '../geometry/types.js';
import { rectFromPoints } from '../geometry/types.js';
import { snapPos } from '../geometry/grid.js';
import type { Selection } from '../state/selection.js';
import {
  clearSelection,
  makeSelection,
  toggleInSelection,
} from '../state/selection.js';

/** 拖拽启动阈值（世界像素）：小于该值的位移视为点击 */
export const DRAG_THRESHOLD = 3;

export type MouseButton = 0 | 1 | 2;

export type FsmState =
  | { name: 'idle' }
  | { name: 'placing'; kind: string; ghost: Pos }
  | {
      name: 'dragging';
      target: 'selection' | 'wire';
      /** 点击命中的对象（mouseup 未移动时回发 click 动作） */
      clicked: { kind: 'component' | 'wire'; id: string } | null;
      start: Pos;
      last: Pos;
      moved: boolean;
    }
  | { name: 'wiring'; from: PortRef; cursor: Pos }
  | { name: 'marquee'; start: Pos; current: Pos; additive: boolean };

export type FsmEvent =
  | { type: 'setTool'; kind: string | null }
  | { type: 'mousedown'; pos: Pos; button: MouseButton; shift: boolean }
  | { type: 'mousemove'; pos: Pos; shift: boolean }
  | { type: 'mouseup'; pos: Pos; button: MouseButton; shift: boolean }
  | { type: 'dblclick'; pos: Pos }
  | { type: 'cancel' };

export type FsmAction =
  | { type: 'select'; selection: Selection }
  | { type: 'hover'; pos: Pos | null }
  | { type: 'beginDrag' }
  | { type: 'place'; kind: string; pos: Pos }
  | { type: 'movePreview'; delta: Pos }
  | { type: 'commitMove'; delta: Pos }
  | { type: 'cancelMove' }
  | { type: 'bendPreview'; pos: Pos }
  | { type: 'commitBend'; pos: Pos }
  | { type: 'cancelBend' }
  | { type: 'commitWire'; from: PortRef; to: PortRef }
  | { type: 'commitMarquee'; rect: Rect; additive: boolean }
  | { type: 'click'; kind: 'component' | 'wire'; id: string }
  | { type: 'status'; message: string };

/** 命中的端口（含世界坐标，供悬停高亮） */
export interface HitPort extends PortRef {
  pos: Pos;
}

/** 世界只读查询接口（控制器实现；测试注入桩） */
export interface FsmQuery {
  portAt(pos: Pos): HitPort | null;
  componentAt(pos: Pos): ComponentInstance | null;
  wireAt(pos: Pos): Wire | null;
  readonly selection: Selection;
}

/** 转移结果 */
export interface TransitionResult {
  state: FsmState;
  actions: FsmAction[];
}

/** 初始状态 */
export function initialFsmState(): FsmState {
  return { name: 'idle' };
}

function dist(a: Pos, b: Pos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 拖拽位移的吸附增量 */
function snapDelta(start: Pos, pos: Pos): Pos {
  const s = snapPos(start);
  const p = snapPos(pos);
  return { x: p.x - s.x, y: p.y - s.y };
}

/**
 * 状态机转移（纯函数）。
 * 未列出的 (状态, 事件) 组合一律为"拒绝"：状态原样返回、无动作。
 */
export function transition(state: FsmState, event: FsmEvent, q: FsmQuery): TransitionResult {
  switch (state.name) {
    case 'idle':
      return fromIdle(state, event, q);
    case 'placing':
      return fromPlacing(state, event, q);
    case 'dragging':
      return fromDragging(state, event, q);
    case 'wiring':
      return fromWiring(state, event, q);
    case 'marquee':
      return fromMarquee(state, event, q);
  }
}

/* ---------------------------------- idle ---------------------------------- */

function fromIdle(state: Extract<FsmState, { name: 'idle' }>, event: FsmEvent, q: FsmQuery): TransitionResult {
  switch (event.type) {
    case 'setTool': {
      if (event.kind === null) return { state, actions: [] }; // 已在选择工具：拒绝
      return { state: { name: 'placing', kind: event.kind, ghost: { x: 0, y: 0 } }, actions: [] };
    }
    case 'mousedown': {
      if (event.button === 1) return { state, actions: [] }; // 中键留给平移
      if (event.button === 2) {
        // 右键：清除选择
        return { state, actions: [{ type: 'select', selection: clearSelection() }] };
      }
      const port = q.portAt(event.pos);
      if (port) {
        return {
          state: { name: 'wiring', from: { componentId: port.componentId, port: port.port }, cursor: event.pos },
          actions: [{ type: 'hover', pos: port.pos }],
        };
      }
      const comp = q.componentAt(event.pos);
      if (comp) {
        const actions: FsmAction[] = [];
        let selection = q.selection;
        if (event.shift) {
          selection = toggleInSelection(selection, 'component', comp.id);
          actions.push({ type: 'select', selection });
        } else if (!selection.components.has(comp.id)) {
          selection = makeSelection([comp.id], []);
          actions.push({ type: 'select', selection });
        }
        actions.push({ type: 'beginDrag' });
        return {
          state: {
            name: 'dragging',
            target: 'selection',
            clicked: { kind: 'component', id: comp.id },
            start: event.pos,
            last: event.pos,
            moved: false,
          },
          actions,
        };
      }
      const wire = q.wireAt(event.pos);
      if (wire) {
        const actions: FsmAction[] = [];
        let selection = q.selection;
        if (event.shift) {
          selection = toggleInSelection(selection, 'wire', wire.id);
          actions.push({ type: 'select', selection });
        } else if (!selection.wires.has(wire.id)) {
          selection = makeSelection([], [wire.id]);
          actions.push({ type: 'select', selection });
        }
        actions.push({ type: 'beginDrag' });
        return {
          state: {
            name: 'dragging',
            target: 'wire',
            clicked: { kind: 'wire', id: wire.id },
            start: event.pos,
            last: event.pos,
            moved: false,
          },
          actions,
        };
      }
      // 空白处：框选（非 shift 先清空选择）
      const actions: FsmAction[] = event.shift ? [] : [{ type: 'select', selection: clearSelection() }];
      return {
        state: { name: 'marquee', start: event.pos, current: event.pos, additive: event.shift },
        actions,
      };
    }
    case 'mousemove': {
      const port = q.portAt(event.pos);
      return { state, actions: [{ type: 'hover', pos: port ? port.pos : null }] };
    }
    case 'mouseup':
      return { state, actions: [] };
    case 'dblclick': {
      // 双击 = click 信号（控制器：INPUT 翻转 / 打开 Inspector）
      const comp = q.componentAt(event.pos);
      if (comp) return { state, actions: [{ type: 'click', kind: 'component', id: comp.id }] };
      const wire = q.wireAt(event.pos);
      if (wire) return { state, actions: [{ type: 'click', kind: 'wire', id: wire.id }] };
      return { state, actions: [] };
    }
    case 'cancel':
      return { state, actions: [{ type: 'select', selection: clearSelection() }] };
  }
}

/* --------------------------------- placing --------------------------------- */

function fromPlacing(state: Extract<FsmState, { name: 'placing' }>, event: FsmEvent, _q: FsmQuery): TransitionResult {
  switch (event.type) {
    case 'setTool': {
      if (event.kind === null) return { state: { name: 'idle' }, actions: [] };
      return { state: { ...state, kind: event.kind }, actions: [] };
    }
    case 'mousemove':
      return { state: { ...state, ghost: snapPos(event.pos) }, actions: [] };
    case 'mousedown': {
      if (event.button === 1) return { state, actions: [] };
      if (event.button === 2) return { state: { name: 'idle' }, actions: [] }; // 右键退出放置
      return {
        state, // 保持 placing，可连续放置
        actions: [{ type: 'place', kind: state.kind, pos: snapPos(state.ghost) }],
      };
    }
    case 'mouseup':
    case 'dblclick':
      return { state, actions: [] };
    case 'cancel':
      return { state: { name: 'idle' }, actions: [] };
  }
}

/* --------------------------------- dragging -------------------------------- */

function fromDragging(state: Extract<FsmState, { name: 'dragging' }>, event: FsmEvent, _q: FsmQuery): TransitionResult {
  switch (event.type) {
    case 'mousemove': {
      const moved = state.moved || dist(state.start, event.pos) > DRAG_THRESHOLD;
      const next = { ...state, last: event.pos, moved };
      if (!moved) return { state: next, actions: [] };
      if (state.target === 'selection') {
        return { state: next, actions: [{ type: 'movePreview', delta: snapDelta(state.start, event.pos) }] };
      }
      return { state: next, actions: [{ type: 'bendPreview', pos: snapPos(event.pos) }] };
    }
    case 'mouseup': {
      if (event.button === 2) {
        // 右键抬起：取消拖拽
        return finishDrag(state, false);
      }
      if (event.button === 1) return { state, actions: [] };
      return finishDrag(state, true);
    }
    case 'cancel':
      return finishDrag(state, false);
    case 'setTool':
    case 'mousedown':
    case 'dblclick':
      return { state, actions: [] }; // 拖拽中忽略其他事件
  }
}

function finishDrag(state: Extract<FsmState, { name: 'dragging' }>, commit: boolean): TransitionResult {
  const actions: FsmAction[] = [];
  if (!state.moved) {
    // 未移动 → 视为点击
    if (state.clicked && commit) actions.push({ type: 'click', ...state.clicked });
    return { state: { name: 'idle' }, actions };
  }
  if (!commit) {
    actions.push(state.target === 'selection' ? { type: 'cancelMove' } : { type: 'cancelBend' });
    return { state: { name: 'idle' }, actions };
  }
  if (state.target === 'selection') {
    actions.push({ type: 'commitMove', delta: snapDelta(state.start, state.last) });
  } else {
    actions.push({ type: 'commitBend', pos: snapPos(state.last) });
  }
  return { state: { name: 'idle' }, actions };
}

/* ---------------------------------- wiring --------------------------------- */

function fromWiring(state: Extract<FsmState, { name: 'wiring' }>, event: FsmEvent, q: FsmQuery): TransitionResult {
  switch (event.type) {
    case 'mousemove': {
      const port = q.portAt(event.pos);
      return { state: { ...state, cursor: event.pos }, actions: [{ type: 'hover', pos: port ? port.pos : null }] };
    }
    case 'mousedown': {
      if (event.button === 1) return { state, actions: [] };
      if (event.button === 2) return { state: { name: 'idle' }, actions: [] }; // 右键取消布线
      const port = q.portAt(event.pos);
      if (!port) return { state: { name: 'idle' }, actions: [] }; // 点空白：取消布线
      if (port.componentId === state.from.componentId && port.port === state.from.port) {
        return {
          state,
          actions: [{ type: 'status', message: '布线取消：不能连接到同一端口' }],
        };
      }
      return {
        state: { name: 'idle' },
        actions: [
          { type: 'commitWire', from: state.from, to: { componentId: port.componentId, port: port.port } },
        ],
      };
    }
    case 'mouseup':
    case 'dblclick':
    case 'setTool':
      return { state, actions: [] };
    case 'cancel':
      return { state: { name: 'idle' }, actions: [] };
  }
}

/* --------------------------------- marquee --------------------------------- */

function fromMarquee(state: Extract<FsmState, { name: 'marquee' }>, event: FsmEvent, _q: FsmQuery): TransitionResult {
  switch (event.type) {
    case 'mousemove':
      return { state: { ...state, current: event.pos }, actions: [] };
    case 'mouseup': {
      if (event.button === 1) return { state, actions: [] };
      if (event.button === 2) return { state: { name: 'idle' }, actions: [] }; // 右键取消框选
      return {
        state: { name: 'idle' },
        actions: [
          { type: 'commitMarquee', rect: rectFromPoints(state.start, state.current), additive: state.additive },
        ],
      };
    }
    case 'cancel':
      return { state: { name: 'idle' }, actions: [] };
    case 'setTool':
    case 'mousedown':
    case 'dblclick':
      return { state, actions: [] };
  }
}
