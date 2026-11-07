/**
 * 引擎主体：实现冻结契约的 SimEngine。
 *
 * 职责边界：
 * - 结构与校验 → netlist.ts；传播 → events.ts；时钟 → clock.ts；序列化 → serialize.ts。
 * - load()/reset() 之后内部自动做一次"稳定传播"（等价于一次内部 tick），
 *   使 read() 立刻反映 settled 值——契约没有禁止，且对 UI 更友好（决策见 REPORT.md）。
 * - reset() 重置时序状态，但保留用户已 setInput 的 PIN_IN 值（复位"电路状态"而非"激励"）。
 * - setInput() 只接受 PIN_IN 的输出端口；其余端口一律抛错（这是编程错误，不是网表缺陷）。
 */

import type {
  ChipBehavior,
  Diagnostic,
  Netlist,
  PortRef,
  SimEngine,
  TickResult,
} from '../contract';
import { applyClockEdge } from './clock';
import {
  collectDynamicDiagnostics,
  createRuntime,
  propagate,
  refreshComponentOutputs,
  refreshNet,
  type PropOutcome,
  type Runtime,
} from './events';
import { buildCircuit, portKey, validateNetlist, type BuiltCircuit } from './netlist';
import { maskOfWidth } from './primitives';

export class EngineImpl implements SimEngine {
  private readonly behaviors = new Map<string, ChipBehavior>();
  /** load 时深拷贝的原始网表（registerBehavior 触发重建时使用） */
  private source: Netlist | null = null;
  private circuit: BuiltCircuit | null = null;
  private rt: Runtime | null = null;
  private staticDiags: Diagnostic[] = [];
  private dynamicDiags: Diagnostic[] = [];

  constructor(behaviors: Iterable<[string, ChipBehavior]>) {
    for (const [kind, behavior] of behaviors) {
      this.behaviors.set(kind, behavior);
    }
  }

  registerBehavior(kind: string, behavior: ChipBehavior): void {
    this.behaviors.set(kind, behavior);
    // 若已有载入网表则重建：让此前因未知 kind 而惰性的组件立即激活
    if (this.source) this.build();
  }

  load(netlist: Netlist): void {
    this.source = cloneNetlist(netlist);
    this.build();
  }

  reset(): void {
    const { circuit, rt } = this.requireState();
    // 保存外部激励（PIN_IN 的当前值），状态全量重建后恢复
    const pins: { compIndex: number; value: number }[] = [];
    for (const comp of circuit.comps) {
      if (comp.kind !== 'PIN_IN') continue;
      pins.push({ compIndex: comp.index, value: (rt.states[comp.index]?.['value'] as number) ?? 0 });
    }
    this.rebuildRuntime(circuit);
    for (const pin of pins) {
      this.rt!.states[pin.compIndex]!['value'] = pin.value;
      // 恢复激励后必须同步刷新输出快照（驱动合并读的是 lastOut，不是 state）
      refreshComponentOutputs(circuit, this.rt!, pin.compIndex);
    }
    this.settle();
  }

  setInput(port: PortRef, value: number): void {
    const { circuit, rt } = this.requireState();
    const ci = circuit.compById.get(port.componentId);
    if (ci === undefined) {
      throw new Error(`setInput：组件 "${port.componentId}" 不存在`);
    }
    const comp = circuit.comps[ci]!;
    if (comp.kind !== 'PIN_IN') {
      throw new Error(`setInput：只能驱动 PIN_IN 组件（"${port.componentId}" 是 ${comp.kind}）`);
    }
    const out = comp.outPorts.find((pt) => pt.port === port.port);
    if (!out) {
      throw new Error(`setInput：组件 "${port.componentId}" 没有输出端口 "${port.port}"`);
    }
    rt.states[ci]!['value'] = Math.trunc(value) & out.mask;
    // 重新求值 PIN_IN 输出（lastOut 驱动合并读的是快照），net 值变化则标脏等待传播
    for (const net of refreshComponentOutputs(circuit, rt, ci)) {
      rt.dirty.add(net);
    }
    this.refreshDynamic();
  }

  read(port: PortRef): number {
    const { circuit, rt } = this.requireState();
    const ci = circuit.compById.get(port.componentId);
    if (ci === undefined) {
      throw new Error(`read：组件 "${port.componentId}" 不存在`);
    }
    const pi = circuit.portIndex.get(portKey(ci, port.port));
    if (pi === undefined) {
      throw new Error(`read：组件 "${port.componentId}" 没有端口 "${port.port}"`);
    }
    return rt.netValues[circuit.ports[pi]!.net]!;
  }

  tick(maxSteps?: number): TickResult {
    if (!this.circuit || !this.rt) return { stable: true, steps: 0, oscillated: false };
    const limit = Math.max(1, Math.trunc(maxSteps ?? this.defaultMaxSteps()));
    const outcome = propagate(this.circuit, this.rt, limit);
    this.dynamicDiags = collectDynamicDiagnostics(this.circuit, this.rt, outcome);
    return { stable: outcome.stable, steps: outcome.steps, oscillated: outcome.oscillated };
  }

  clockEdge(): void {
    // 未加载网表时是无害空操作（与 tick 的宽松语义一致）
    if (!this.circuit || !this.rt) return;
    applyClockEdge(this.circuit, this.rt);
    this.refreshDynamic();
  }

  diagnostics(): Diagnostic[] {
    return [...this.staticDiags, ...this.dynamicDiags];
  }

  /** 供同包工具（校验脚本等）复用：以当前行为表做纯校验 */
  validate(netlist: Netlist): Diagnostic[] {
    return validateNetlist(netlist, this.behaviors);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private build(): void {
    const { circuit, diagnostics } = buildCircuit(this.source!, this.behaviors);
    this.circuit = circuit;
    this.staticDiags = diagnostics;
    this.rebuildRuntime(circuit);
    this.settle();
  }

  /** 新建运行时并把全部 net 置脏（下一步 settle 做全量传播） */
  private rebuildRuntime(circuit: BuiltCircuit): void {
    const rt = createRuntime(circuit);
    // 先按播种输出刷新一遍所有 net（CONST/PIN_IN 等无输入组件的值在此时落定）
    for (let n = 0; n < circuit.nets.length; n++) refreshNet(circuit, rt, n);
    rt.dirty = new Set(circuit.nets.map((_, i) => i));
    this.rt = rt;
  }

  /** 全量传播一遍（load/reset 的内部 settle） */
  private settle(): void {
    const { circuit, rt } = this.requireState();
    propagate(circuit, rt, this.defaultMaxSteps());
    this.refreshDynamic();
  }

  private defaultMaxSteps(): number {
    // 组合深度最坏为组件数（长链），2 倍余量 + 常数；下限 1000 保证小电路振荡可检出
    return Math.max(1000, 2 * (this.circuit?.comps.length ?? 0) + 64);
  }

  private refreshDynamic(): void {
    this.dynamicDiags = collectDynamicDiagnostics(this.circuit, this.rt, null);
  }

  private requireState(): { circuit: BuiltCircuit; rt: Runtime } {
    if (!this.circuit || !this.rt) {
      throw new Error('引擎尚未 load() 网表');
    }
    return { circuit: this.circuit, rt: this.rt };
  }
}

/** 深拷贝网表：引擎持有自己的副本，外部后续修改不影响仿真 */
export function cloneNetlist(netlist: Netlist): Netlist {
  return {
    components: netlist.components.map((c) => ({
      id: c.id,
      kind: c.kind,
      pos: { x: c.pos.x, y: c.pos.y },
      props: { ...c.props },
    })),
    wires: netlist.wires.map((w) => ({
      id: w.id,
      from: { ...w.from },
      to: { ...w.to },
    })),
  };
}

/** 便捷函数：某 PIN_IN 输出端口的掩码（测试与工具用） */
export function pinMask(width: number): number {
  return maskOfWidth(width);
}
