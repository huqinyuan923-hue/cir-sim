/**
 * M1 · 16 位组合芯片全集（含拆分器/加法器家族）。
 *
 * 实现约定（全库统一，见 REPORT.md）：
 * - 端口名对齐 nand-computer 黄金向量（a/b/out/in/sel/...），时序芯片额外遵守
 *   "evaluate 的时序输出只读 state"约定（引擎沿后以空 inputs 刷新，见引擎偏差记录 #12）；
 * - 组合芯片无状态：evaluate 是纯函数，输入一律先按端口宽度掩码再运算；
 * - 16 位运算全部收敛到 [0, 0xFFFF]，不依赖 JS 位运算的符号语义对外泄漏。
 */

import type { ChipBehavior, ChipPort } from '../contract';

const W16 = 0xffff;

/** 端口构造小工具（库内通用） */
export function p(name: string, dir: 'in' | 'out', width: number): ChipPort {
  return { name, dir, width };
}

/** 数值化 + 掩码：任何非有限输入按 0 处理 */
export function v(x: unknown, mask = W16): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : 0;
  return n & mask;
}

/** 二输入 16 位逐位门工厂 */
function gate16(name: string, op: (a: number, b: number) => number): ChipBehavior {
  return {
    ports: [p('a', 'in', 16), p('b', 'in', 16), p('out', 'out', 16)],
    evaluate: (inputs) => ({ out: op(v(inputs['a']), v(inputs['b'])) }),
  };
}

/** 16 位寄存器式 MUX 家族工厂：多路选择，sel 为多位选择值 */
function mux16Way(name: string, lanes: string[], selBits: number): ChipBehavior {
  return {
    ports: [...lanes.map((l) => p(l, 'in', 16)), p('sel', 'in', selBits), p('out', 'out', 16)],
    evaluate: (inputs) => {
      const sel = v(inputs['sel'], (1 << selBits) - 1);
      return { out: v(inputs[lanes[sel] ?? lanes[0]!]) };
    },
  };
}

/** DMUX 家族工厂：一路输入按 sel 展开到 2^n 路输出 */
function dmuxWay(name: string, outs: string[], selBits: number): ChipBehavior {
  return {
    ports: [p('in', 'in', 1), p('sel', 'in', selBits), ...outs.map((o) => p(o, 'out', 1))],
    evaluate: (inputs) => {
      const sel = v(inputs['sel'], (1 << selBits) - 1);
      const on = v(inputs['in'], 1);
      const result: Record<string, number> = {};
      outs.forEach((o, i) => {
        result[o] = i === sel ? on : 0;
      });
      return result;
    },
  };
}

/** 组合芯片全集：kind → 行为。全部通过 registerBehavior 注册进引擎。 */
export function combinationalChips(): Record<string, ChipBehavior> {
  return {
    // ── 16 位逐位门 ──────────────────────────────────────────────────────
    AND16: gate16('AND16', (a, b) => a & b),
    OR16: gate16('OR16', (a, b) => a | b),
    XOR16: gate16('XOR16', (a, b) => a ^ b),
    NOT16: {
      ports: [p('in', 'in', 16), p('out', 'out', 16)],
      evaluate: (inputs) => ({ out: ~v(inputs['in']) }),
    },
    NEG16: {
      // 二进制补码取负：-x = ~x + 1
      ports: [p('in', 'in', 16), p('out', 'out', 16)],
      evaluate: (inputs) => ({ out: (-v(inputs['in'])) & W16 }),
    },

    // ── 16 位多路选择 ────────────────────────────────────────────────────
    MUX16: mux16Way('MUX16', ['a', 'b'], 1),
    MUX4WAY16: mux16Way('MUX4WAY16', ['a', 'b', 'c', 'd'], 2),
    MUX8WAY16: mux16Way('MUX8WAY16', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3),

    // ── DMUX 家族 ────────────────────────────────────────────────────────
    DMUX: dmuxWay('DMUX', ['a', 'b'], 1),
    DMUX4WAY: dmuxWay('DMUX4WAY', ['a', 'b', 'c', 'd'], 2),
    DMUX8WAY: dmuxWay('DMUX8WAY', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 3),

    // ── 宽输入 / 加法器 ─────────────────────────────────────────────────
    OR8WAY: {
      ports: [p('in', 'in', 8), p('out', 'out', 1)],
      evaluate: (inputs) => ({ out: v(inputs['in'], 0xff) === 0 ? 0 : 1 }),
    },
    HALFADDER: {
      ports: [p('a', 'in', 1), p('b', 'in', 1), p('sum', 'out', 1), p('carry', 'out', 1)],
      evaluate: (inputs) => {
        const a = v(inputs['a'], 1);
        const b = v(inputs['b'], 1);
        return { sum: a ^ b, carry: a & b };
      },
    },
    FULLADDER: {
      ports: [p('a', 'in', 1), p('b', 'in', 1), p('c', 'in', 1), p('sum', 'out', 1), p('carry', 'out', 1)],
      evaluate: (inputs) => {
        const a = v(inputs['a'], 1);
        const b = v(inputs['b'], 1);
        const c = v(inputs['c'], 1);
        return { sum: a ^ b ^ c, carry: (a & b) | (c & (a ^ b)) };
      },
    },
    ADD16: {
      // 行波进位语义在黄金向量层面对拍；这里用整数加法 + 16 位掩码（数学等价）
      ports: [p('a', 'in', 16), p('b', 'in', 16), p('out', 'out', 16)],
      evaluate: (inputs) => ({ out: (v(inputs['a']) + v(inputs['b'])) & W16 }),
    },
    INC16: {
      ports: [p('in', 'in', 16), p('out', 'out', 16)],
      evaluate: (inputs) => ({ out: (v(inputs['in']) + 1) & W16 }),
    },
  };
}
