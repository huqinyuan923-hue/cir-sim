/**
 * M2 · 时序芯片：寄存器家族与程序计数器 PC。
 *
 * 时钟语义（与引擎 clock.ts 的三阶段同步语义配套）：
 * - evaluate：输出只读 state.q（沿后引擎以空 inputs 刷新输出，见引擎偏差记录 #12）；
 * - onClockEdge：统一采样沿前 inputs，按优先级提交新值。
 *
 * PC 优先级（黄金向量 pc.json 固化）：reset > load > inc > 保持；
 * 计数宽度 15 位（程序地址空间 32K），32767 自增回绕到 0。
 */

import type { BehaviorState, ChipBehavior } from '../contract';
import { p, v } from './bits';

const W16 = 0xffff;

/** load 位通用读取 */
function loadBit(inputs: Readonly<Record<string, number>>): boolean {
  return v(inputs['load'], 1) === 1;
}

/** 寄存器工厂：宽 width 的 load 型寄存器（Bit=1 位 / Register16=16 位） */
export function makeRegister(width: number): ChipBehavior {
  return {
    ports: [p('in', 'in', width), p('load', 'in', 1), p('out', 'out', width)],
    initState: (): BehaviorState => ({ q: 0 }),
    evaluate: (_inputs, state) => ({ out: v(state['q']) }),
    onClockEdge: (inputs, state) => {
      if (loadBit(inputs)) state['q'] = v(inputs['in']);
    },
  };
}

/** 程序计数器：reset > load > inc > 保持，15 位回绕 */
export const PC_BEHAVIOR: ChipBehavior = {
  ports: [
    p('in', 'in', 16),
    p('load', 'in', 1),
    p('inc', 'in', 1),
    p('reset', 'in', 1),
    p('out', 'out', 16),
  ],
  initState: (): BehaviorState => ({ q: 0 }),
  evaluate: (_inputs, state) => ({ out: v(state['q']) }),
  onClockEdge: (inputs, state) => {
    if (v(inputs['reset'], 1)) {
      state['q'] = 0;
    } else if (v(inputs['load'], 1)) {
      state['q'] = v(inputs['in']);
    } else if (v(inputs['inc'], 1)) {
      state['q'] = (v(state['q']) + 1) & 0x7fff;
    }
  },
};

/** 寄存器家族（同一实现，不同 kind 名——对齐黄金向量与 Hack 术语） */
export function sequentialChips(): Record<string, ChipBehavior> {
  return {
    BIT: makeRegister(1),
    REGISTER16: makeRegister(16),
    REGISTER: makeRegister(16),
    AREGISTER: makeRegister(16),
    DREGISTER: makeRegister(16),
    PC: PC_BEHAVIOR,
  };
}

/** 供测试/展开器引用的 16 位掩码 */
export { W16 };
