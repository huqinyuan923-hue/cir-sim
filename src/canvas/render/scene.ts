/**
 * 渲染场景模型（Scene）：渲染器一帧所需的全部只读输入。
 * 控制器每帧组装；渲染器对引擎/FSM/DOM 一无所知，纯函数式绘制。
 */

import type { Diagnostic, Netlist, Pos } from '../contract.js';
import type { Selection } from '../state/selection.js';
import type { Rect } from '../geometry/types.js';
import type { BendOverlay } from '../geometry/wirepath.js';

/** 视图状态（世界 ↔ 屏幕变换） */
export interface ViewState {
  pan: Pos;
  zoom: number;
  width: number;
  height: number;
}

/** 交互覆盖层（由控制器从 FSM 状态投影而来） */
export interface CanvasOverlay {
  /** 放置幽灵：kind + 吸附后位置 */
  ghost?: { kind: string; pos: Pos };
  /** 布线预览折线（世界坐标，已含引出段与化简） */
  wirePreview?: Pos[];
  /** 框选矩形（世界坐标，未归一化） */
  marquee?: Rect;
  /** 悬停端口高亮位置 */
  hoverPort?: Pos;
}

/** 诊断的可视投影（渲染器不做诊断解析） */
export interface DiagnosticVisuals {
  floatingWireIds: ReadonlySet<string>;
  conflictWireIds: ReadonlySet<string>;
  /** error 级别涉及的组件（红罩） */
  errorComponentIds: ReadonlySet<string>;
  /** warning 级别涉及的组件（橙罩） */
  warnComponentIds: ReadonlySet<string>;
  oscillating: boolean;
}

/** 引擎值表：portKey → 值（-1 floating，0/1 有效） */
export type ValueTable = ReadonlyMap<string, number>;

/** 一帧场景 */
export interface Scene {
  netlist: Netlist;
  selection: Selection;
  values: ValueTable;
  diags: DiagnosticVisuals;
  overlay: CanvasOverlay;
  view: ViewState;
  bends: BendOverlay;
  /** 当前时间戳（ms），用于振荡闪烁 */
  time: number;
}

/** 空场景（测试方便） */
export function emptyScene(netlist: Netlist, view: ViewState): Scene {
  return {
    netlist,
    selection: { components: new Set(), wires: new Set() },
    values: new Map(),
    diags: {
      floatingWireIds: new Set(),
      conflictWireIds: new Set(),
      errorComponentIds: new Set(),
      warnComponentIds: new Set(),
      oscillating: false,
    },
    overlay: {},
    view,
    bends: new Map(),
    time: 0,
  };
}

/** 诊断数组 → 可视投影（控制器每帧调用） */
export function projectDiagnostics(diags: readonly Diagnostic[]): DiagnosticVisuals {
  const floatingWireIds = new Set<string>();
  const conflictWireIds = new Set<string>();
  const errorComponentIds = new Set<string>();
  const warnComponentIds = new Set<string>();
  let oscillating = false;
  for (const d of diags) {
    const target = d.level === 'error' ? errorComponentIds : warnComponentIds;
    if (d.kind === 'floating') {
      for (const id of d.wireIds ?? []) floatingWireIds.add(id);
      for (const id of d.componentIds ?? []) target.add(id);
    } else if (d.kind === 'conflict') {
      for (const id of d.wireIds ?? []) conflictWireIds.add(id);
    } else if (d.kind === 'oscillation') {
      oscillating = true;
    }
    for (const id of d.componentIds ?? []) target.add(id);
  }
  return { floatingWireIds, conflictWireIds, errorComponentIds, warnComponentIds, oscillating };
}
