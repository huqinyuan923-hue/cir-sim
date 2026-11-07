/**
 * M2 · 时序芯片黄金向量对拍（Bit / Register / DRegister / ARegister / PC / RAM8 / RAM64）。
 * 时序语义：set → tick → 断言沿前输出 out → clockEdge → tick → 断言沿后输出 outAfter。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { sequentialChips, makeRegister, PC_BEHAVIOR } from '../src/chips/seq';
import { makeRam, memoryChips, ROM32K_BEHAVIOR } from '../src/chips/memory';
import { adoptRom, clearAllHandles } from '../src/chips/handles';
import { buildChipBench, runClockedGolden, type GoldenFile } from '../src/testkit/harness';
import { loadGolden } from './helpers/golden';
import { makeEngine } from '../src/testkit/engineFactory';

/** 库芯片总表（时序 + 存储） */
function allSeqChips(): Record<string, import('../src/contract').ChipBehavior> {
  return { ...sequentialChips(), ...memoryChips() };
}

const CLOCKED_GOLDENS = ['bit', 'register', 'dregister', 'aregister', 'pc', 'ram8', 'ram64'] as const;

const GOLDEN_TO_KIND: Record<string, string> = {
  bit: 'BIT',
  register: 'REGISTER',
  dregister: 'DREGISTER',
  aregister: 'AREGISTER',
  pc: 'PC',
  ram8: 'RAM8',
  ram64: 'RAM64',
};

describe('M2 · 时序芯片黄金向量对拍', () => {
  beforeEach(() => clearAllHandles());

  for (const name of CLOCKED_GOLDENS) {
    it(`${name}.json`, () => {
      const golden = loadGolden(name) as Extract<GoldenFile, { kind: 'clocked' }>;
      expect(golden.kind).toBe('clocked');
      expect(golden.cases.length).toBeGreaterThan(0);
      const kind = GOLDEN_TO_KIND[name]!;
      const behavior = allSeqChips()[kind];
      if (!behavior) throw new Error(`缺芯片 ${kind}`);
      const bench = buildChipBench(makeEngine, behavior);
      const run = runClockedGolden(bench, golden);
      expect(run).toBe(golden.cases.length);
    });
  }
});

describe('M2 · 时钟语义细化（load/inc/reset 优先级与沿采样）', () => {
  beforeEach(() => clearAllHandles());

  it('REGISTER16：load=0 时沿不采样，输出保持', () => {
    const bench = buildChipBench(makeEngine, makeRegister(16));
    bench.set('in', 0xabcd);
    bench.set('load', 1);
    bench.clockEdge();
    bench.tick();
    expect(bench.get('out')).toBe(0xabcd);
    bench.set('in', 0x1234);
    bench.set('load', 0);
    bench.tick();
    expect(bench.get('out')).toBe(0xabcd); // 沿前组合输出仍是旧值
    bench.clockEdge();
    bench.tick();
    expect(bench.get('out')).toBe(0xabcd); // load=0 沿后仍保持
  });

  it('PC：reset 优先于 load 优先于 inc（同沿多控制位）', () => {
    const bench = buildChipBench(makeEngine, PC_BEHAVIOR);
    bench.set('in', 500);
    bench.set('load', 1);
    bench.set('inc', 1);
    bench.clockEdge();
    bench.tick();
    expect(bench.get('out')).toBe(500); // load 胜过 inc
    bench.set('reset', 1);
    bench.set('load', 1);
    bench.set('inc', 1);
    bench.clockEdge();
    bench.tick();
    expect(bench.get('out')).toBe(0); // reset 胜过 load/inc
  });

  it('PC：32767 自增回绕 0（15 位程序地址）', () => {
    const bench = buildChipBench(makeEngine, PC_BEHAVIOR);
    bench.set('in', 32767);
    bench.set('load', 1);
    bench.clockEdge();
    bench.set('load', 0);
    bench.set('inc', 1);
    bench.tick();
    bench.clockEdge();
    bench.tick();
    expect(bench.get('out')).toBe(0);
  });

  it('RAM16K：两地址交替写读互不干扰（译码抽查）', () => {
    const bench = buildChipBench(makeEngine, makeRam(14, { registered: true }));
    bench.set('address', 0);
    bench.set('in', 1111);
    bench.set('load', 1);
    bench.clockEdge();
    bench.set('address', 16383);
    bench.set('in', 2222);
    bench.set('load', 1);
    bench.clockEdge();
    bench.set('load', 0);
    bench.set('address', 0);
    bench.tick();
    expect(bench.get('out')).toBe(1111);
    bench.set('address', 16383);
    bench.tick();
    expect(bench.get('out')).toBe(2222);
  });

  it('RAM 家族（512/4K/16K）边界地址写读（黄金向量只覆盖到 RAM64，此处补全）', () => {
    for (const [kind, log2, top] of [
      ['RAM512', 9, 511],
      ['RAM4K', 12, 4095],
      ['RAM16K', 14, 16383],
    ] as const) {
      const behavior = makeRam(log2, { registered: kind === 'RAM16K' });
      const bench = buildChipBench(makeEngine, behavior, { props: { id: `t-${kind}` } });
      bench.set('address', 0);
      bench.set('in', 0xaa55);
      bench.set('load', 1);
      bench.clockEdge();
      bench.set('address', top);
      bench.set('in', 0x55aa);
      bench.clockEdge();
      bench.set('load', 0);
      bench.set('address', top);
      bench.tick();
      expect(bench.get('out')).toBe(0x55aa);
      bench.set('address', 0);
      bench.tick();
      expect(bench.get('out')).toBe(0xaa55);
    }
  });

  it('ROM32K：句柄烧程序 → 组合读出；reset() 后程序幸存', () => {
    // 程序必须在 load() 之前经句柄播种（真引擎脏集驱动：load 后直改 words 不会自动重算）
    const rom = adoptRom({ id: 'rom-t' });
    rom.words[0] = 0x1111;
    rom.words[32767] = 0x2222;
    const bench = buildChipBench(makeEngine, ROM32K_BEHAVIOR, { props: { id: 'rom-t' } });
    bench.set('address', 0);
    bench.tick();
    expect(bench.get('out')).toBe(0x1111);
    bench.set('address', 32767);
    bench.tick();
    expect(bench.get('out')).toBe(0x2222);
    // reset 重建运行时 → initState 重新认领同一状态对象 → 程序仍在
    bench.engine.reset();
    bench.tick();
    expect(bench.get('out')).toBe(0x2222);
  });

  it('沿后空 inputs 刷新：RAM 输出在 clockEdge 后立即反映新写入值（地址缓存模式）', () => {
    const bench = buildChipBench(makeEngine, makeRam(6));
    bench.set('address', 42);
    bench.set('in', 777);
    bench.set('load', 1);
    bench.clockEdge(); // 沿：写入 mem[42]，且沿后以空 inputs 刷新输出
    // 此时不 tick，直接读：输出应是 mem[42]（lastAddr 缓存生效）
    expect(bench.get('out')).toBe(777);
  });
});
