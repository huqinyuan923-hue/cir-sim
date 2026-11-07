/**
 * MEMDECODE · 内存映射地址译码器（Hack 总装专用库芯片）。
 *
 * 语义（与 SPEC 内存映射逐位等价，tests/m4 有 65536 地址全扫描差分对拍）：
 *   isram = (A & 0xC000) == 0x0000   // 0x0000–0x3FFF
 *   isscr = (A & 0xC000) == 0x4000   // 0x4000–0x5FFF
 *   kbd   = A == 0x6000              // KBD 精确匹配（0x6001–0x7FFF 越界 → 全 0，越界读得 0）
 *
 * 为什么做成原生芯片而不是门树（决策 D5，见 REPORT.md）：
 * 门树版需要 13 个 SPLIT + 14 个门（12 OR + 2 NOT）+ 2 AND ≈ 29 组件；Hack 全机
 * 每个 A 总线变化都会让整棵树重新求值——占全机每周期求值量的一半以上。
 * 原生单芯片把这 29 次求值压成 1 次，且这正是真实计算机里"地址译码器"那颗 IC 的抽象。
 */

import type { ChipBehavior } from '../contract';
import { p, v } from './bits';

export const MEMDECODE_BEHAVIOR: ChipBehavior = {
  ports: [
    p('a', 'in', 16),
    p('isram', 'out', 1),
    p('isscr', 'out', 1),
    p('kbd', 'out', 1),
  ],
  evaluate: (inputs) => {
    const a = v(inputs['a']);
    const hi = a & 0xc000;
    return {
      isram: hi === 0x0000 ? 1 : 0,
      isscr: hi === 0x4000 ? 1 : 0,
      kbd: a === 0x6000 ? 1 : 0,
    };
  },
};
