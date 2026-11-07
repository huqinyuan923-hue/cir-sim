/**
 * 内置原语行为表。
 *
 * 设计要点（与任务书语义一一对应）：
 * - 全部原语（含 PIN_IN/PIN_OUT/SPLIT/JOIN/DFF）都通过同一条 registerBehavior 机制注册，
 *   引擎对"内置原语"与"库芯片"不做任何双标处理。
 * - 端口值一律是非负整数（位掩码语义）：引擎在写入 net 前会按端口宽度做掩码，
 *   因此 evaluate 内部可以放心做按位运算（例如 NAND 的取反）。
 * - 位宽上限 31：JS 位运算是 32 位有符号，取 31 保证 (1 << w) - 1 恒为正且安全。
 * - 动态宽度：契约的 ChipBehavior.ports 是静态声明，无法表达"随 props 缩放"的端口，
 *   因此引擎约定 props.width 覆盖所有端口的声明宽度，仅少数"天然单 bit"的端口
 *   （见 SINGLE_BIT_PORTS）固定为 1。该约定是契约的表达力缺口，已在 README-偏差记录.md 登记。
 */

import type { BehaviorState, ChipBehavior, ChipPort } from '../contract';

/** 位宽上限（含）。31 位以内可安全使用 32 位有符号位运算。 */
export const MAX_WIDTH = 31;

/** 把任意宽度收敛到 [1, MAX_WIDTH] */
export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.min(MAX_WIDTH, Math.max(1, Math.trunc(w)));
}

/** 宽松地把 props 值转成整数：数字直接截断；字符串按数字解析；非法回落 fallback */
export function toInt(v: number | string | undefined, fallback: number): number {
  if (typeof v === 'number') {
    const n = Math.trunc(v);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** 从 props 读取位宽（默认 1） */
export function widthOf(props: Readonly<Record<string, number | string>>, fallback = 1): number {
  return clampWidth(toInt(props['width'], fallback));
}

/**
 * 固定 1 位的端口清单（键为 `${kind}.${port}`）。
 * 这些端口在语义上天然是单 bit，不随 props.width 缩放：
 * - SPLIT.bit / JOIN.bit：拆分与拼接的最小粒度就是 1 位
 * - MUX.sel：选择信号恒为 1 位
 * - DFF.d / DFF.q：触发器按任务书为单 bit 时序单元
 */
export const SINGLE_BIT_PORTS: ReadonlySet<string> = new Set([
  'SPLIT.bit',
  'JOIN.bit',
  'MUX.sel',
  'DFF.d',
  'DFF.q',
]);

/** 判断某组件的某端口是否固定 1 位 */
export function isSingleBitPort(kind: string, port: string): boolean {
  return SINGLE_BIT_PORTS.has(`${kind}.${port}`);
}

/** 由位宽得掩码：width 位全 1 */
export function maskOfWidth(width: number): number {
  return width >= MAX_WIDTH ? 0x7fffffff : (1 << width) - 1;
}

function p(name: string, dir: 'in' | 'out', width: number): ChipPort {
  return { name, dir, width };
}

/** 从时序状态里读数值字段（状态容器类型是 Record<string, unknown>） */
function stateNum(state: BehaviorState, key: string): number {
  const v = state[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

function inputNum(inputs: Readonly<Record<string, number>>, key: string): number {
  const v = inputs[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** 二输入门通用工厂：in a、in b、out y，按位运算 */
function binaryGate(op: (a: number, b: number) => number): ChipBehavior {
  return {
    ports: [p('a', 'in', 1), p('b', 'in', 1), p('y', 'out', 1)],
    evaluate: (inputs) => ({ y: op(inputNum(inputs, 'a'), inputNum(inputs, 'b')) }),
  };
}

/** 内置原语表：kind → 行为。createEngine 启动时逐个 registerBehavior。 */
export const PRIMITIVES: Readonly<Record<string, ChipBehavior>> = {
  // ── 二输入门 ────────────────────────────────────────────────────────────
  AND: binaryGate((a, b) => a & b),
  OR: binaryGate((a, b) => a | b),
  XOR: binaryGate((a, b) => a ^ b),
  NAND: binaryGate((a, b) => ~(a & b)), // 取反结果可能为负，引擎写 net 前按宽度掩码收回非负

  // ── NOT ────────────────────────────────────────────────────────────────
  NOT: {
    ports: [p('a', 'in', 1), p('y', 'out', 1)],
    evaluate: (inputs) => ({ y: ~inputNum(inputs, 'a') }),
  },

  // ── MUX：sel=0 选 in0，sel 非 0 选 in1 ─────────────────────────────────
  MUX: {
    ports: [p('in0', 'in', 1), p('in1', 'in', 1), p('sel', 'in', 1), p('y', 'out', 1)],
    evaluate: (inputs) => ({
      y: (inputNum(inputs, 'sel') & 1) !== 0 ? inputNum(inputs, 'in1') : inputNum(inputs, 'in0'),
    }),
  },

  // ── CONST：恒驱动 props.value ──────────────────────────────────────────
  // 端口声明宽度取上限 31：value 自描述宽度（写 5 就输出 5）；
  // 显式 props.width 会覆盖声明宽度，把输出收窄（value 再按掩码截断）。
  CONST: {
    ports: [p('y', 'out', 31)],
    evaluate: (_inputs, _state, props) => ({ y: toInt(props['value'], 0) }),
  },

  // ── PIN_IN：电路对外输入口，值由 setInput 写入 state ─────────────────────
  PIN_IN: {
    ports: [p('y', 'out', 1)],
    initState: () => ({ value: 0 }),
    evaluate: (_inputs, state) => ({ y: stateNum(state, 'value') }),
  },

  // ── PIN_OUT：电路对外输出口，仅观察（对外读它的 a 端口所在 net） ──────────
  PIN_OUT: {
    ports: [p('a', 'in', 1)],
    evaluate: () => ({}),
  },

  // ── SPLIT：从 bus 取第 index 位 ────────────────────────────────────────
  SPLIT: {
    ports: [p('bus', 'in', 16), p('bit', 'out', 1)],
    evaluate: (inputs, _state, props) => {
      const index = Math.min(Math.max(toInt(props['index'], 0), 0), 30);
      return { bit: (inputNum(inputs, 'bus') >>> index) & 1 };
    },
  },

  // ── JOIN：把单 bit 放到 bus 的第 high 位 ───────────────────────────────
  // 说明：JOIN 的驱动掩码是特殊的（只驱动 1<<high 这一位），
  // 该规则由引擎按 kind=JOIN 特判（见 netlist.ts 的 outMask 计算），
  // 这样"两条 JOIN 拼 16 位总线"才能在不触发多驱动冲突的情况下工作。
  JOIN: {
    ports: [p('bit', 'in', 1), p('bus', 'out', 16)],
    evaluate: (inputs, _state, props) => {
      const width = widthOf(props, 16);
      const high = Math.min(Math.max(toInt(props['high'], 0), 0), width - 1);
      return { bus: (inputNum(inputs, 'bit') & 1) << high };
    },
  },

  // ── DFF：平时 q 保持；clockEdge() 全局上升沿 q ← d ──────────────────────
  // 毛刺免疫由结构保证：传播期只可能改 d 所在 net，q 只在 onClockEdge 里采样。
  DFF: {
    ports: [p('d', 'in', 1), p('q', 'out', 1)],
    initState: () => ({ q: 0 }),
    evaluate: (_inputs, state) => ({ q: stateNum(state, 'q') & 1 }),
    onClockEdge: (inputs, state) => {
      state['q'] = inputNum(inputs, 'd') & 1;
    },
  },
};
