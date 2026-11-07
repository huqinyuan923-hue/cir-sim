/**
 * M3 测试 · 交互状态机全转移覆盖
 * 覆盖：5 状态 × 全部事件类型（含变体），非法转移拒绝，典型事件序列。
 */
import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD,
  initialFsmState,
  transition,
} from '../../src/canvas/interact/fsm.js';
import type {
  FsmAction,
  FsmEvent,
  FsmQuery,
  FsmState,
  HitPort,
} from '../../src/canvas/interact/fsm.js';
import type { ComponentInstance, Netlist, Pos, Wire } from '../../src/canvas/contract.js';
import { EMPTY_SELECTION } from '../../src/canvas/state/selection.js';
import type { Selection } from '../../src/canvas/state/selection.js';
import { componentBoundsOf, portPos } from '../../src/canvas/model/shapes.js';
import { wirePolyline } from '../../src/canvas/geometry/wirepath.js';
import { pointInRect, polylineHit } from '../../src/canvas/geometry/hit.js';

/* ------------------------------ 测试世界桩 ------------------------------ */

const WORLD: Netlist = {
  components: [
    { id: 'c1', kind: 'INPUT', pos: { x: 0, y: 0 }, props: {} },
    { id: 'c2', kind: 'AND', pos: { x: 100, y: 0 }, props: {} },
  ],
  wires: [{ id: 'w1', from: { componentId: 'c1', port: 'OUT' }, to: { componentId: 'c2', port: 'A' } }],
};

const PORT_POS: Record<string, Pos> = {
  'c1:OUT': { x: 40, y: 20 },
  'c2:A': { x: 100, y: 20 },
  'c2:B': { x: 100, y: 60 },
  'c2:OUT': { x: 160, y: 40 },
};

function makeQuery(netlist: Netlist = WORLD, selection: Selection = EMPTY_SELECTION): FsmQuery {
  return {
    portAt(pos: Pos): HitPort | null {
      for (const comp of netlist.components) {
        for (const p of ['OUT', 'IN', 'A', 'B', 'D', 'CLK', 'Q']) {
          const pp = portPos(comp, p);
          if (pp && Math.hypot(pp.x - pos.x, pp.y - pos.y) <= 6) {
            return { componentId: comp.id, port: p, pos: pp };
          }
        }
      }
      return null;
    },
    componentAt(pos: Pos): ComponentInstance | null {
      for (const comp of netlist.components) {
        if (pointInRect(pos, componentBoundsOf(comp))) return comp;
      }
      return null;
    },
    wireAt(pos: Pos): Wire | null {
      for (const w of netlist.wires) {
        if (polylineHit(wirePolyline(netlist, w), pos, 5)) return w;
      }
      return null;
    },
    selection,
  };
}

const IDLE: FsmState = initialFsmState();
const Q = makeQuery();

/** 便捷事件构造 */
const down = (pos: Pos, button: 0 | 1 | 2 = 0, shift = false): FsmEvent => ({ type: 'mousedown', pos, button, shift });
const up = (pos: Pos, button: 0 | 1 | 2 = 0, shift = false): FsmEvent => ({ type: 'mouseup', pos, button, shift });
const move = (pos: Pos, shift = false): FsmEvent => ({ type: 'mousemove', pos, shift });
const tool = (kind: string | null): FsmEvent => ({ type: 'setTool', kind });
const dbl = (pos: Pos): FsmEvent => ({ type: 'dblclick', pos });
const cancel: FsmEvent = { type: 'cancel' };

/** 进入各状态的快捷路径 */
function enterPlacing(kind = 'AND'): FsmState {
  return transition(IDLE, tool(kind), Q).state;
}
function enterMarquee(): FsmState {
  return transition(IDLE, down({ x: 300, y: 300 }), Q).state;
}
function enterDragSelection(): FsmState {
  return transition(IDLE, down({ x: 120, y: 40 }), Q).state; // 命中 c2 AND
}
function enterDragWire(): FsmState {
  return transition(IDLE, down({ x: 70, y: 20 }), Q).state; // 命中 w1
}
function enterWiring(): FsmState {
  return transition(IDLE, down({ x: 40, y: 20 }), Q).state; // 命中 c1:OUT
}

/** 序列驱动：返回最终状态与累计动作 */
function run(start: FsmState, events: FsmEvent[], q: FsmQuery = Q): { state: FsmState; actions: FsmAction[] } {
  let state = start;
  const actions: FsmAction[] = [];
  for (const e of events) {
    const r = transition(state, e, q);
    state = r.state;
    actions.push(...r.actions);
  }
  return { state, actions };
}

/* --------------------------------- idle --------------------------------- */

describe('idle 状态', () => {
  it('setTool(kind) → placing，幽灵在原点', () => {
    const r = transition(IDLE, tool('AND'), Q);
    expect(r.state).toEqual({ name: 'placing', kind: 'AND', ghost: { x: 0, y: 0 } });
    expect(r.actions).toEqual([]);
  });

  it('setTool(null) 在 idle 被拒绝（保持 idle）', () => {
    const r = transition(IDLE, tool(null), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([]);
  });

  it('mousedown 命中端口 → wiring', () => {
    const r = transition(IDLE, down({ x: 40, y: 20 }), Q);
    expect(r.state.name).toBe('wiring');
    if (r.state.name === 'wiring') {
      expect(r.state.from).toEqual({ componentId: 'c1', port: 'OUT' });
    }
  });

  it('mousedown 命中未选组件 → 选中并进入 dragging，动作顺序 select→beginDrag', () => {
    const r = transition(IDLE, down({ x: 120, y: 40 }), Q);
    expect(r.state.name).toBe('dragging');
    expect(r.actions[0]).toEqual({ type: 'select', selection: { components: new Set(['c2']), wires: new Set() } });
    expect(r.actions[1]).toEqual({ type: 'beginDrag' });
  });

  it('mousedown 命中已选组件 → 不重复发 select，仍 beginDrag', () => {
    const q = makeQuery(WORLD, { components: new Set(['c2']), wires: new Set() });
    const r = transition(IDLE, down({ x: 120, y: 40 }), q);
    expect(r.state.name).toBe('dragging');
    expect(r.actions).toEqual([{ type: 'beginDrag' }]);
  });

  it('mousedown + shift 命中组件 → 切换选择并拖拽', () => {
    const q = makeQuery(WORLD, { components: new Set(['c2']), wires: new Set() });
    const r = transition(IDLE, down({ x: 120, y: 40 }, 0, true), q);
    expect(r.actions[0]).toEqual({ type: 'select', selection: { components: new Set(), wires: new Set() } });
  });

  it('mousedown 命中连线 → dragging(target wire)', () => {
    const r = transition(IDLE, down({ x: 70, y: 20 }), Q);
    expect(r.state.name).toBe('dragging');
    if (r.state.name === 'dragging') expect(r.state.target).toBe('wire');
    expect(r.actions[0]).toEqual({ type: 'select', selection: { components: new Set(), wires: new Set(['w1']) } });
  });

  it('mousedown 空白 → marquee 且清空选择', () => {
    const r = transition(IDLE, down({ x: 300, y: 300 }), Q);
    expect(r.state).toEqual({ name: 'marquee', start: { x: 300, y: 300 }, current: { x: 300, y: 300 }, additive: false });
    expect(r.actions).toEqual([{ type: 'select', selection: { components: new Set(), wires: new Set() } }]);
  });

  it('mousedown 空白 + shift → marquee 追加模式不清空', () => {
    const r = transition(IDLE, down({ x: 300, y: 300 }, 0, true), Q);
    expect(r.state.name).toBe('marquee');
    expect(r.actions).toEqual([]);
    if (r.state.name === 'marquee') expect(r.state.additive).toBe(true);
  });

  it('mousedown 中键被拒绝（留给平移）', () => {
    const r = transition(IDLE, down({ x: 40, y: 20 }, 1), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([]);
  });

  it('mousedown 右键 → 清空选择，保持 idle', () => {
    const r = transition(IDLE, down({ x: 120, y: 40 }, 2), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([{ type: 'select', selection: { components: new Set(), wires: new Set() } }]);
  });

  it('mousemove 悬停端口 → hover 端口坐标', () => {
    const r = transition(IDLE, move({ x: 41, y: 20 }), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([{ type: 'hover', pos: { x: 40, y: 20 } }]);
  });

  it('mousemove 悬停空白 → hover null', () => {
    const r = transition(IDLE, move({ x: 300, y: 300 }), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([{ type: 'hover', pos: null }]);
  });

  it('mouseup 在 idle 被拒绝', () => {
    const r = transition(IDLE, up({ x: 0, y: 0 }), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([]);
  });

  it('dblclick 组件 → click 动作（供 Inspector/翻转），保持 idle', () => {
    const r = transition(IDLE, dbl({ x: 10, y: 10 }), Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([{ type: 'click', kind: 'component', id: 'c1' }]);
  });

  it('cancel → 清空选择', () => {
    const r = transition(IDLE, cancel, Q);
    expect(r.state).toBe(IDLE);
    expect(r.actions).toEqual([{ type: 'select', selection: { components: new Set(), wires: new Set() } }]);
  });
});

/* -------------------------------- placing -------------------------------- */

describe('placing 状态', () => {
  it('mousemove 更新幽灵位置并吸附网格', () => {
    const r = transition(enterPlacing(), move({ x: 123, y: 57 }), Q);
    expect(r.state).toEqual({ name: 'placing', kind: 'AND', ghost: { x: 120, y: 60 } });
  });

  it('mousedown 左键放置组件（吸附位置）并保持 placing（连续放置）', () => {
    const s = transition(enterPlacing(), move({ x: 200, y: 40 }), Q).state;
    const r = transition(s, down({ x: 200, y: 40 }), Q);
    expect(r.actions).toEqual([{ type: 'place', kind: 'AND', pos: { x: 200, y: 40 } }]);
    expect(r.state.name).toBe('placing');
  });

  it('mousedown 右键 → 退出 placing', () => {
    const r = transition(enterPlacing(), down({ x: 0, y: 0 }, 2), Q);
    expect(r.state).toEqual({ name: 'idle' });
  });

  it('mousedown 中键被拒绝', () => {
    const s = enterPlacing();
    const r = transition(s, down({ x: 0, y: 0 }, 1), Q);
    expect(r.state).toBe(s);
    expect(r.actions).toEqual([]);
  });

  it('mouseup / dblclick 在 placing 被拒绝', () => {
    const s = enterPlacing();
    expect(transition(s, up({ x: 0, y: 0 }), Q).state).toBe(s);
    expect(transition(s, dbl({ x: 0, y: 0 }), Q).state).toBe(s);
  });

  it('setTool 切换幽灵组件', () => {
    const r = transition(enterPlacing(), tool('OR'), Q);
    expect(r.state).toEqual({ name: 'placing', kind: 'OR', ghost: { x: 0, y: 0 } });
  });

  it('setTool(null) → idle', () => {
    const r = transition(enterPlacing(), tool(null), Q);
    expect(r.state).toEqual({ name: 'idle' });
  });

  it('cancel → idle', () => {
    const r = transition(enterPlacing(), cancel, Q);
    expect(r.state).toEqual({ name: 'idle' });
  });
});

/* ---------------------------- dragging(selection) ---------------------------- */

describe('dragging(selection) 状态', () => {
  it('小于阈值移动不产生预览', () => {
    const s = enterDragSelection();
    const r = transition(s, move({ x: 120 + 2, y: 40 }), Q);
    expect(r.state).toEqual({ ...s, last: { x: 122, y: 40 }, moved: false });
    expect(r.actions).toEqual([]);
  });

  it('超过阈值移动 → movePreview（吸附增量）', () => {
    const s = enterDragSelection();
    const r = transition(s, move({ x: 120 + 23, y: 40 + 19 }), Q);
    expect(r.state).toEqual({ ...s, last: { x: 143, y: 59 }, moved: true });
    expect(r.actions).toEqual([{ type: 'movePreview', delta: { x: 20, y: 20 } }]);
  });

  it('mouseup 移动后 → commitMove → idle', () => {
    const s1 = transition(enterDragSelection(), move({ x: 140, y: 60 }), Q).state;
    const r = transition(s1, up({ x: 140, y: 60 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([{ type: 'commitMove', delta: { x: 20, y: 20 } }]);
  });

  it('mouseup 未移动 → click 动作（INPUT 翻转由控制器处理）→ idle', () => {
    const s = enterDragSelection();
    const r = transition(s, up({ x: 120, y: 40 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([{ type: 'click', kind: 'component', id: 'c2' }]);
  });

  it('mouseup 右键 → cancelMove → idle', () => {
    const s1 = transition(enterDragSelection(), move({ x: 140, y: 60 }), Q).state;
    const r = transition(s1, up({ x: 140, y: 60 }, 2), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([{ type: 'cancelMove' }]);
  });

  it('cancel → cancelMove → idle', () => {
    const s1 = transition(enterDragSelection(), move({ x: 140, y: 60 }), Q).state;
    const r = transition(s1, cancel, Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([{ type: 'cancelMove' }]);
  });

  it('拖拽中 setTool / mousedown / dblclick 全部拒绝', () => {
    const s = transition(enterDragSelection(), move({ x: 140, y: 60 }), Q).state;
    expect(transition(s, tool('OR'), Q).state).toBe(s);
    expect(transition(s, down({ x: 300, y: 300 }), Q).state).toBe(s);
    expect(transition(s, dbl({ x: 140, y: 60 }), Q).state).toBe(s);
    expect(transition(s, tool('OR'), Q).actions).toEqual([]);
  });
});

/* ------------------------------ dragging(wire) ------------------------------ */

describe('dragging(wire) 状态', () => {
  it('移动超过阈值 → bendPreview（吸附）', () => {
    const s = enterDragWire();
    const r = transition(s, move({ x: 70 + 22, y: 20 + 41 }), Q);
    expect(r.actions).toEqual([{ type: 'bendPreview', pos: { x: 100, y: 60 } }]);
  });

  it('mouseup 移动后 → commitBend → idle', () => {
    const s1 = transition(enterDragWire(), move({ x: 92, y: 61 }), Q).state;
    const r = transition(s1, up({ x: 92, y: 61 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([{ type: 'commitBend', pos: { x: 100, y: 60 } }]);
  });

  it('mouseup 未移动 → click wire → idle', () => {
    const r = transition(enterDragWire(), up({ x: 70, y: 20 }), Q);
    expect(r.actions).toEqual([{ type: 'click', kind: 'wire', id: 'w1' }]);
  });

  it('cancel → cancelBend', () => {
    const s1 = transition(enterDragWire(), move({ x: 92, y: 61 }), Q).state;
    const r = transition(s1, cancel, Q);
    expect(r.actions).toEqual([{ type: 'cancelBend' }]);
  });
});

/* -------------------------------- wiring -------------------------------- */

describe('wiring 状态', () => {
  it('mousemove 更新 cursor 与 hover（远离端口时 hover=null）', () => {
    const r = transition(enterWiring(), move({ x: 140, y: 30 }), Q);
    expect(r.state).toEqual({
      name: 'wiring',
      from: { componentId: 'c1', port: 'OUT' },
      cursor: { x: 140, y: 30 },
    });
    expect(r.actions).toEqual([{ type: 'hover', pos: null }]);
  });

  it('mousemove 悬停目标端口 → hover 其坐标', () => {
    const r = transition(enterWiring(), move({ x: 100, y: 20 }), Q);
    expect(r.actions).toEqual([{ type: 'hover', pos: { x: 100, y: 20 } }]);
  });

  it('mousedown 另一端口 → commitWire → idle', () => {
    const r = transition(enterWiring(), down({ x: 100, y: 20 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([
      { type: 'commitWire', from: { componentId: 'c1', port: 'OUT' }, to: { componentId: 'c2', port: 'A' } },
    ]);
  });

  it('mousedown 同一端口 → 非法拒绝（保持 wiring + status）', () => {
    const s = enterWiring();
    const r = transition(s, down({ x: 40, y: 20 }), Q);
    expect(r.state).toBe(s);
    expect(r.actions).toEqual([{ type: 'status', message: '布线取消：不能连接到同一端口' }]);
  });

  it('mousedown 空白 → 取消布线回 idle（无动作）', () => {
    const r = transition(enterWiring(), down({ x: 300, y: 300 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([]);
  });

  it('mousedown 右键 → 取消布线', () => {
    const r = transition(enterWiring(), down({ x: 100, y: 20 }, 2), Q);
    expect(r.state).toEqual({ name: 'idle' });
  });

  it('布线中 setTool / mouseup / dblclick 拒绝', () => {
    const s = enterWiring();
    expect(transition(s, tool('AND'), Q).state).toBe(s);
    expect(transition(s, up({ x: 0, y: 0 }), Q).state).toBe(s);
    expect(transition(s, dbl({ x: 0, y: 0 }), Q).state).toBe(s);
  });

  it('cancel → idle', () => {
    const r = transition(enterWiring(), cancel, Q);
    expect(r.state).toEqual({ name: 'idle' });
  });
});

/* -------------------------------- marquee -------------------------------- */

describe('marquee 状态', () => {
  it('mousemove 更新框选终点', () => {
    const r = transition(enterMarquee(), move({ x: 100, y: 80 }), Q);
    expect(r.state).toEqual({ name: 'marquee', start: { x: 300, y: 300 }, current: { x: 100, y: 80 }, additive: false });
  });

  it('mouseup → commitMarquee（归一化矩形由动作携带）', () => {
    const s1 = transition(enterMarquee(), move({ x: 100, y: 80 }), Q).state;
    const r = transition(s1, up({ x: 100, y: 80 }), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([
      { type: 'commitMarquee', rect: { x: 100, y: 80, w: 200, h: 220 }, additive: false },
    ]);
  });

  it('shift 框选 → additive=true', () => {
    const s = transition(IDLE, down({ x: 300, y: 300 }, 0, true), Q).state;
    const s1 = transition(s, move({ x: 100, y: 80 }), Q).state;
    const r = transition(s1, up({ x: 100, y: 80 }), Q);
    expect(r.actions[0]).toEqual({
      type: 'commitMarquee',
      rect: { x: 100, y: 80, w: 200, h: 220 },
      additive: true,
    });
  });

  it('mouseup 右键 → 取消框选（无 commit）', () => {
    const s1 = transition(enterMarquee(), move({ x: 100, y: 80 }), Q).state;
    const r = transition(s1, up({ x: 100, y: 80 }, 2), Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([]);
  });

  it('框选中 setTool / mousedown / dblclick / mouseup(中键) 拒绝', () => {
    const s = enterMarquee();
    expect(transition(s, tool('AND'), Q).state).toBe(s);
    expect(transition(s, down({ x: 0, y: 0 }), Q).state).toBe(s);
    expect(transition(s, dbl({ x: 0, y: 0 }), Q).state).toBe(s);
    expect(transition(s, up({ x: 0, y: 0 }, 1), Q).state).toBe(s);
  });

  it('cancel → idle（无动作）', () => {
    const r = transition(enterMarquee(), cancel, Q);
    expect(r.state).toEqual({ name: 'idle' });
    expect(r.actions).toEqual([]);
  });
});

/* ------------------------------- 事件序列 ------------------------------- */

describe('端到端事件序列', () => {
  it('拖动组件完整序列：select → beginDrag → movePreview → commitMove', () => {
    const { state, actions } = run(IDLE, [
      down({ x: 120, y: 40 }),
      move({ x: 122, y: 41 }), // 位移 √5 < 阈值
      move({ x: 140, y: 60 }),
      up({ x: 140, y: 60 }),
    ]);
    expect(state).toEqual({ name: 'idle' });
    expect(actions.map((a) => a.type)).toEqual(['select', 'beginDrag', 'movePreview', 'commitMove']);
  });

  it('两点布线序列：wiring → commitWire，控制器据此建线', () => {
    const { state, actions } = run(IDLE, [down({ x: 40, y: 20 }), move({ x: 160, y: 40 }), down({ x: 160, y: 40 })]);
    expect(state).toEqual({ name: 'idle' });
    expect(actions).toContainEqual({
      type: 'commitWire',
      from: { componentId: 'c1', port: 'OUT' },
      to: { componentId: 'c2', port: 'OUT' },
    });
  });

  it('连续放置两个组件 → 两个 place 动作', () => {
    const { actions } = run(IDLE, [
      tool('INPUT'),
      move({ x: 0, y: 0 }),
      down({ x: 0, y: 0 }),
      move({ x: 0, y: 80 }),
      down({ x: 0, y: 80 }),
      cancel,
    ]);
    const places = actions.filter((a) => a.type === 'place');
    expect(places).toHaveLength(2);
    expect(places[1]).toEqual({ type: 'place', kind: 'INPUT', pos: { x: 0, y: 80 } });
  });

  it('框选序列：marquee → commitMarquee（控制器执行选择）', () => {
    const { actions } = run(IDLE, [
      down({ x: -50, y: -50 }),
      move({ x: 200, y: 100 }),
      up({ x: 200, y: 100 }),
    ]);
    expect(actions).toEqual([
      { type: 'select', selection: { components: new Set(), wires: new Set() } },
      { type: 'commitMarquee', rect: { x: -50, y: -50, w: 250, h: 150 }, additive: false },
    ]);
  });

  it('非法序列：wiring 中 setTool 被拒后仍能完成布线', () => {
    const { state, actions } = run(IDLE, [
      down({ x: 40, y: 20 }),
      tool('AND'), // 非法：拒绝
      down({ x: 100, y: 20 }),
    ]);
    expect(state).toEqual({ name: 'idle' });
    expect(actions).toContainEqual({
      type: 'commitWire',
      from: { componentId: 'c1', port: 'OUT' },
      to: { componentId: 'c2', port: 'A' },
    });
  });

  it('阈值常量为 3（世界像素）', () => {
    expect(DRAG_THRESHOLD).toBe(3);
  });
});
