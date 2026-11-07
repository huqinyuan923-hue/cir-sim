/**
 * M2 · 存储芯片：RAM 家族与 ROM32K。
 *
 * 地址缓存模式（本部核心决策 D2，详见 REPORT.md）：
 * 引擎在时钟沿后会以"空 inputs"刷新时钟芯片输出。RAM/SCREEN 的输出是
 * mem[address]，若 evaluate 直接读 inputs.address，沿后刷新会静默跌回 mem[0]。
 * 因此：evaluate 收到真实 inputs 时更新 state.lastAddr，空 inputs 时退回缓存；
 * onClockEdge 也用采样值同步 lastAddr——沿后刷新读到的就是沿前最后地址的内容。
 *
 * RAM 家族共用一套行为工厂，地址译码树由容量参数化（8/64/512/4K/16K）。
 * RAM16K 额外接入句柄注册表（机器总装需要种子/读出，见 handles.ts）。
 */

import type { ChipBehavior } from '../contract';
import { p, v } from './bits';
import { adoptRam16K, adoptRom, type RamState, type RomState } from './handles';

function num(v0: unknown): number {
  return typeof v0 === 'number' && Number.isFinite(v0) ? Math.trunc(v0) : 0;
}

/** RAM 行为工厂：容量 = 2^sizeLog2 字 */
export function makeRam(sizeLog2: number, opts?: { registered?: boolean }): ChipBehavior {
  const size = 1 << sizeLog2;
  const addrMask = size - 1;
  return {
    ports: [
      p('in', 'in', 16),
      p('load', 'in', 1),
      p('address', 'in', sizeLog2),
      p('out', 'out', 16),
    ],
    initState: opts?.registered
      ? (props): RamState => adoptRam16K(props)
      : () => ({ mem: new Array<number>(size).fill(0), lastAddr: 0 }),
    evaluate: (inputs, state) => {
      const s = state as unknown as RamState;
      const addr = 'address' in inputs ? v(inputs['address'], addrMask) : v(s.lastAddr, addrMask);
      s.lastAddr = addr;
      return { out: v(s.mem[addr]) };
    },
    onClockEdge: (inputs, state) => {
      const s = state as unknown as RamState;
      const addr = v(inputs['address'], addrMask);
      s.lastAddr = addr;
      if (v(inputs['load'], 1)) s.mem[addr] = v(inputs['in']);
    },
  };
}

/** ROM32K：组合读出（无时钟），words 由句柄注册表供给（烧程序入口） */
export const ROM32K_BEHAVIOR: ChipBehavior = {
  ports: [p('address', 'in', 15), p('out', 'out', 16)],
  initState: (props): RomState => adoptRom(props),
  evaluate: (inputs, state) => {
    const s = state as unknown as RomState;
    const addr = v(inputs['address'], 0x7fff);
    return { out: v(s.words[addr]) };
  },
};

export function memoryChips(): Record<string, ChipBehavior> {
  return {
    RAM8: makeRam(3),
    RAM64: makeRam(6),
    RAM512: makeRam(9),
    RAM4K: makeRam(12),
    RAM16K: makeRam(14, { registered: true }),
    ROM32K: ROM32K_BEHAVIOR,
  };
}
