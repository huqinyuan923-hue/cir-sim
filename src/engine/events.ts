/**
 * 事件驱动传播：运行时状态 + 单元延迟 delta cycle + 多驱动按位合并。
 *
 * 传播算法（与暴力参考实现保持同一可观测语义）：
 * 1. 维护"脏 net 集合"；frontier = 输入落在脏 net 上的组件（首趟脏集为全体 net，即全量）。
 * 2. 一趟 delta 分两个阶段，保证单元延迟语义：
 *    阶段一：frontier 内所有组件统一从"本趟开始时的 net 值"求值，只更新各组件的
 *    lastOut（最后一次输出快照），不立即写 net；
 *    阶段二：对所有受影响 net 重新按"位线与"合并全部驱动，值变化的 net 进入下一趟脏集。
 * 3. 某趟没有任何 net 变化 → stable；步数达到 maxSteps 仍有变化 → oscillated。
 *
 * 组件本趟未被 frontier 选中 ⇔ 其输入未变化 ⇔ 输出必然不变，因此
 * "frontier 增量求值"与"全量重算"完全等价——这正是差分对拍能成立的原因。
 */

import type { Diagnostic } from '../contract';
import type { BuiltCircuit, BuiltPort } from './netlist';

/** 引擎运行时状态 */
export interface Runtime {
  /** netId → 当前值（非负整数，位掩码语义） */
  netValues: number[];
  /** compIndex → 芯片状态（组合芯片一般为空对象） */
  states: Record<string, unknown>[];
  /** compIndex → outSlot → 最后一次求值的输出（驱动合并的依据） */
  lastOut: number[][];
  /** 待传播的脏 net 集合 */
  dirty: Set<number>;
}

/** 一次传播的结果（附加上下文供诊断使用） */
export interface PropOutcome {
  stable: boolean;
  steps: number;
  oscillated: boolean;
  /** 最后一趟仍在求值的组件下标（振荡诊断的定位依据） */
  frontier: number[];
}

/** 创建运行时：初始化状态、以零输入播种各组件输出快照 */
export function createRuntime(circuit: BuiltCircuit): Runtime {
  const rt: Runtime = {
    netValues: circuit.nets.map(() => 0),
    states: [],
    lastOut: [],
    dirty: new Set(),
  };
  for (const comp of circuit.comps) {
    const state = comp.behavior.initState
      ? comp.behavior.initState(comp.instance.props)
      : ({} as Record<string, unknown>);
    rt.states[comp.index] = state;
    const outs = comp.outPorts.map(() => 0);
    // 播种：以全零输入求值一次。组合芯片的输出随后由 settle 传播修正；
    // 无输入端口的芯片（CONST/PIN_IN）输出即为其终值，不会再进入 frontier。
    const inputs: Record<string, number> = {};
    for (const name of comp.inNames) inputs[name] = 0;
    const evaluated = comp.behavior.evaluate(inputs, state, comp.instance.props);
    comp.outPorts.forEach((pt, slot) => {
      outs[slot] = sanitizeOutput(evaluated[pt.port], pt);
    });
    rt.lastOut[comp.index] = outs;
  }
  return rt;
}

/** 输出值清洗：缺端口/非数值按 0 处理，再按端口掩码收回宽度内 */
function sanitizeOutput(raw: unknown, port: BuiltPort): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return n & port.mask;
}

/**
 * 组件状态被直接修改后（setInput / clockEdge）调用：
 * 重新求值该组件输出、更新 lastOut、并立即把值变化的 net 写回（对外立即可读）。
 * @returns net 值发生变化的 net 列表（调用方应把它们加入脏集）
 */
export function refreshComponentOutputs(circuit: BuiltCircuit, rt: Runtime, compIndex: number): number[] {
  const comp = circuit.comps[compIndex]!;
  const state = rt.states[compIndex] ?? {};
  const evaluated = comp.behavior.evaluate({}, state, comp.instance.props);
  const outs = rt.lastOut[compIndex]!;
  const touched = new Set<number>();
  comp.outPorts.forEach((pt, slot) => {
    const v = sanitizeOutput(evaluated[pt.port], pt);
    if (outs[slot] !== v) {
      outs[slot] = v;
      touched.add(pt.net);
    }
  });
  const changed: number[] = [];
  for (const net of touched) {
    if (refreshNet(circuit, rt, net)) changed.push(net);
  }
  return changed;
}

/**
 * 重算单个 net 的合并值（全部驱动按位线与）并按需写回。
 * @returns net 值是否发生变化
 */
export function refreshNet(circuit: BuiltCircuit, rt: Runtime, net: number): boolean {
  const info = circuit.nets[net]!;
  if (info.drivers.length === 0) return false;
  let value = 0;
  let covered = 0;
  for (const pi of info.drivers) {
    const port = circuit.ports[pi]!;
    const v = rt.lastOut[port.compIndex]![port.outSlot] ?? 0;
    const m = port.mask;
    // 已被覆盖的位：线与（不同值 → 0，同时这是冲突位，诊断阶段单独识别）
    value = (value & ~m) | (v & (m & ~covered)) | ((value & v) & (m & covered));
    covered |= m;
  }
  if (rt.netValues[net] !== value) {
    rt.netValues[net] = value;
    return true;
  }
  return false;
}

/** 由脏 net 集合求 frontier：输入落在脏 net 上的组件（去重，保持发现顺序） */
function collectFrontier(circuit: BuiltCircuit, dirty: Set<number>): number[] {
  const seen = new Set<number>();
  for (const net of dirty) {
    const info = circuit.nets[net];
    if (!info) continue;
    for (const pi of info.sinks) seen.add(circuit.ports[pi]!.compIndex);
  }
  return [...seen];
}

/** 求值一个组件：组装 inputs → 调 evaluate → 更新 lastOut；返回值发生变化的 out net */
function evaluateComponent(circuit: BuiltCircuit, rt: Runtime, compIndex: number): number[] {
  const comp = circuit.comps[compIndex]!;
  const inputs: Record<string, number> = {};
  for (let i = 0; i < comp.inNames.length; i++) {
    inputs[comp.inNames[i]!] = rt.netValues[comp.inNets[i]!] ?? 0;
  }
  const state = rt.states[compIndex] ?? {};
  const evaluated = comp.behavior.evaluate(inputs, state, comp.instance.props);
  const outs = rt.lastOut[compIndex]!;
  const touched: number[] = [];
  comp.outPorts.forEach((pt, slot) => {
    const v = sanitizeOutput(evaluated[pt.port], pt);
    if (outs[slot] !== v) {
      outs[slot] = v;
      touched.push(pt.net);
    }
  });
  return touched;
}

/**
 * 组合传播直到稳定（或步数耗尽判振荡）。
 * 退出后 rt.dirty 保留"尚未传播完的变化"：稳定时为空集；振荡时下次 tick 从断点继续。
 */
export function propagate(circuit: BuiltCircuit, rt: Runtime, maxSteps: number): PropOutcome {
  let steps = 0;
  let stable = true;
  let frontier = collectFrontier(circuit, rt.dirty);
  while (frontier.length > 0) {
    if (steps >= maxSteps) {
      stable = false;
      break;
    }
    // 阶段一：统一求值（读本趟开始时的 net 值），收集发生输出变化的 net
    const touched = new Set<number>();
    for (const ci of frontier) {
      for (const net of evaluateComponent(circuit, rt, ci)) touched.add(net);
    }
    // 阶段二：统一提交（单元延迟）
    const changed = new Set<number>();
    for (const net of touched) {
      if (refreshNet(circuit, rt, net)) changed.add(net);
    }
    steps++;
    rt.dirty = changed;
    frontier = collectFrontier(circuit, changed);
  }
  return { stable, steps, oscillated: !stable, frontier };
}

/**
 * 收集动态诊断（每次传播/外部激励变化后重算，整体替换）：
 * - conflict：net 上有 ≥2 个驱动且某一位被写成不同值（error）
 * - oscillation：上一次传播步数耗尽仍未稳定（error，定位到最后一趟 frontier）
 */
export function collectDynamicDiagnostics(
  circuit: BuiltCircuit | null,
  rt: Runtime | null,
  outcome: PropOutcome | null,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (!circuit || !rt) return diags;
  for (const net of circuit.nets) {
    if (net.drivers.length < 2) continue;
    let value = 0;
    let covered = 0;
    let contested = 0;
    for (const pi of net.drivers) {
      const port = circuit.ports[pi]!;
      const v = rt.lastOut[port.compIndex]![port.outSlot] ?? 0;
      const m = port.mask;
      contested |= (m & covered) & (value ^ v);
      value = (value & ~m) | (v & (m & ~covered)) | ((value & v) & (m & covered));
      covered |= m;
    }
    if (contested !== 0) {
      const ids: string[] = [];
      for (const pi of net.drivers) {
        const id = circuit.ports[pi]!.componentId;
        if (!ids.includes(id)) ids.push(id);
      }
      diags.push({
        level: 'error',
        kind: 'conflict',
        message: `net（${describeNet(circuit, net.id)}）多个驱动在第 ${contested.toString(2)} 位取值不同，冲突位按线与记 0`,
        componentIds: ids,
        wireIds: net.wires,
      });
    }
  }
  if (outcome && outcome.oscillated) {
    diags.push({
      level: 'error',
      kind: 'oscillation',
      message: `组合传播在 ${outcome.steps} 步内未收敛，判定为振荡`,
      componentIds: uniqueIds(circuit, outcome.frontier),
    });
  }
  return diags;
}

function describeNet(circuit: BuiltCircuit, netId: number): string {
  const info = circuit.nets[netId]!;
  return info.ports
    .map((pi) => `${circuit.ports[pi]!.componentId}.${circuit.ports[pi]!.port}`)
    .join(' — ');
}

function uniqueIds(circuit: BuiltCircuit, compIndices: number[]): string[] {
  const ids: string[] = [];
  for (const ci of compIndices) {
    const id = circuit.comps[ci]!.id;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
