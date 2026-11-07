/**
 * 时钟上升沿：所有带 onClockEdge 的芯片（内置 DFF 与库芯片同理）同步采样。
 *
 * 同步语义分三个阶段：
 * 1. 采样：全部时钟芯片统一从"沿前"的 net 值组装输入快照；
 * 2. 提交：逐个调用 onClockEdge 更新各自 state（此时任何芯片都看不到别人的新值）；
 * 3. 刷新：重新求值各芯片输出（组合芯片 evaluate 直接读 state），更新输出快照并写 net。
 *
 * 边沿之后的组合传播仍由 tick() 负责（契约："tick() 只做组合传播"）：
 * clockEdge 会把 Q 的新值立即写入 net（read() 能读到），但下游门电路的输出
 * 要等下一次 tick() 才更新。
 */

import type { BuiltCircuit } from './netlist';
import { refreshComponentOutputs, type Runtime } from './events';

export function applyClockEdge(circuit: BuiltCircuit, rt: Runtime): void {
  interface Sample {
    compIndex: number;
    inputs: Record<string, number>;
  }
  // 阶段 1：统一采样沿前输入
  const samples: Sample[] = [];
  for (const ci of circuit.clockedComps) {
    const comp = circuit.comps[ci]!;
    const inputs: Record<string, number> = {};
    for (let i = 0; i < comp.inNames.length; i++) {
      inputs[comp.inNames[i]!] = rt.netValues[comp.inNets[i]!] ?? 0;
    }
    samples.push({ compIndex: ci, inputs });
  }
  // 阶段 2：统一提交状态（采样值互不可见 → 同步触发器语义）
  for (const s of samples) {
    const comp = circuit.comps[s.compIndex]!;
    comp.behavior.onClockEdge!(s.inputs, rt.states[s.compIndex]!, comp.instance.props);
  }
  // 阶段 3：刷新输出快照与 net 值，并把变化加入脏集（等待下一次 tick 传播到下游）
  for (const s of samples) {
    for (const net of refreshComponentOutputs(circuit, rt, s.compIndex)) {
      rt.dirty.add(net);
    }
  }
}
