/**
 * M1 · 组合芯片黄金向量对拍。
 * 向量来源：nand-computer/hardware/golden（拷贝至 golden/，见 README-偏差记录）。
 * 1 位门（Nand/And/Or/...）是引擎内置原语，同样走网表测试台对拍。
 */

import { describe, expect, it } from 'vitest';
import type { ChipBehavior } from '../src/contract';
import { combinationalChips } from '../src/chips/bits';
import { ALU_BEHAVIOR } from '../src/chips/alu';
import { buildChipBench, runCombGolden, type GoldenFile } from '../src/testkit/harness';
import { loadGolden } from './helpers/golden';
import { makeEngine } from '../src/testkit/engineFactory';

/** golden 名（小写）→ 库芯片 kind（同名大写者省略映射） */
const KIND_ALIAS: Record<string, string> = {
  nand: 'NAND',
  and: 'AND',
  or: 'OR',
  not: 'NOT',
  xor: 'XOR',
  mux: 'MUX',
  halfadder: 'HALFADDER',
  fulladder: 'FULLADDER',
  mux4way16: 'MUX4WAY16',
  mux8way16: 'MUX8WAY16',
  dmux: 'DMUX',
  dmux4way: 'DMUX4WAY',
  dmux8way: 'DMUX8WAY',
  or8way: 'OR8WAY',
};

function behaviorFor(goldenName: string): ChipBehavior {
  const library: Record<string, ChipBehavior> = {
    ...combinationalChips(),
    ALU: ALU_BEHAVIOR,
  };
  const prim: Record<string, ChipBehavior> = primBehaviors();
  const kind = KIND_ALIAS[goldenName] ?? goldenName.toUpperCase();
  // 1 位原语端口名与 golden 不同（out↔y、in↔a、a/b↔in0/in1），套端口名适配器
  const PRIM_RENAME: Record<string, Record<string, string>> = {
    nand: { a: 'a', b: 'b', out: 'y' },
    and: { a: 'a', b: 'b', out: 'y' },
    or: { a: 'a', b: 'b', out: 'y' },
    xor: { a: 'a', b: 'b', out: 'y' },
    not: { in: 'a', out: 'y' },
    mux: { a: 'in0', b: 'in1', sel: 'sel', out: 'y' },
  };
  const b = library[kind] ?? prim[kind];
  if (!b) throw new Error(`未找到芯片行为：${goldenName} → ${kind}`);
  const rename = PRIM_RENAME[goldenName];
  return rename ? renamePorts(b, rename) : b;
}

/** 与 devEngine 内置原语同一份行为（1 位门对拍用；M5 后改由真引擎原语承担） */
function primBehaviors(): Record<string, ChipBehavior> {
  const gate = (op: (a: number, b: number) => number): ChipBehavior => ({
    ports: [
      { name: 'a', dir: 'in', width: 1 },
      { name: 'b', dir: 'in', width: 1 },
      { name: 'y', dir: 'out', width: 1 },
    ],
    evaluate: (i) => ({ y: op(i['a'] ?? 0, i['b'] ?? 0) }),
  });
  return {
    NAND: gate((a, b) => ~(a & b)),
    AND: gate((a, b) => a & b),
    OR: gate((a, b) => a | b),
    XOR: gate((a, b) => a ^ b),
    NOT: {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ y: ~(i['a'] ?? 0) }),
    },
    MUX: {
      ports: [
        { name: 'in0', dir: 'in', width: 1 },
        { name: 'in1', dir: 'in', width: 1 },
        { name: 'sel', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (i) => ({ y: (i['sel'] ?? 0) & 1 ? i['in1'] ?? 0 : i['in0'] ?? 0 }),
    },
  };
}

/**
 * 端口名适配器：golden 向量用 Hack 标准名（in/out/a/b），引擎原语用 a/y/in0/in1。
 * 包装成"golden 名字的行为"，对拍 runner 保持完全通用。
 */
function renamePorts(behavior: ChipBehavior, map: Record<string, string>): ChipBehavior {
  // 反向表：原语端口名 → golden 名
  const toGolden: Record<string, string> = {};
  for (const [golden, dut] of Object.entries(map)) toGolden[dut] = golden;
  return {
    ports: behavior.ports.map((pt) => ({ ...pt, name: toGolden[pt.name] ?? pt.name })),
    evaluate: (inputs, state, props) => {
      // golden 名的输入 → 原语名的输入
      const dut: Record<string, number> = {};
      for (const [golden, name] of Object.entries(map)) {
        if (golden in inputs) dut[name] = inputs[golden] ?? 0;
      }
      const outs = behavior.evaluate(dut, state, props);
      const renamed: Record<string, number> = {};
      for (const [k, val] of Object.entries(outs)) renamed[toGolden[k] ?? k] = val;
      return renamed;
    },
  };
}

const COMB_GOLDENS = [
  'nand', 'and', 'or', 'not', 'xor', 'mux',
  'and16', 'or16', 'xor16', 'not16', 'mux16', 'mux4way16', 'mux8way16',
  'dmux', 'dmux4way', 'dmux8way', 'or8way',
  'halfadder', 'fulladder', 'add16', 'inc16', 'alu',
] as const;

describe('M1 · 组合芯片黄金向量对拍', () => {
  for (const name of COMB_GOLDENS) {
    it(`${name}.json`, () => {
      const golden = loadGolden(name) as Extract<GoldenFile, { kind: 'comb' }>;
      expect(golden.kind).toBe('comb');
      expect(golden.cases.length).toBeGreaterThan(0);
      const bench = buildChipBench(makeEngine, behaviorFor(name));
      const run = runCombGolden(bench, golden);
      expect(run).toBe(golden.cases.length);
    });
  }

  it('ALU 覆盖全部 512 组控制位组合（1536 用例）', () => {
    const golden = loadGolden('alu') as Extract<GoldenFile, { kind: 'comb' }>;
    const controlCombos = new Set<string>();
    for (const c of golden.cases) {
      controlCombos.add([c.in['zx'], c.in['nx'], c.in['zy'], c.in['ny'], c.in['f'], c.in['no']].join(','));
    }
    expect(controlCombos.size).toBe(64); // 2^6 控制位组合
    expect(golden.cases.length).toBe(1536);
  });

  it('NEG16 属性对拍：-x ≡ (~x)+1（16 位补码，全 65536 值）', () => {
    const bench = buildChipBench(makeEngine, combinationalChips()['NEG16']!);
    for (let x = 0; x <= 0xffff; x++) {
      bench.set('in', x);
      bench.tick();
      const expected = (-x) & 0xffff;
      const got = bench.get('out');
      if (got !== expected) throw new Error(`NEG16(${x}) 期望 ${expected} 实际 ${got}`);
    }
  });

  it('ADD16 全值域抽查：边界值组合不丢进位', () => {
    const bench = buildChipBench(makeEngine, combinationalChips()['ADD16']!);
    const edges = [0, 1, 2, 0x7fff, 0x8000, 0xfffe, 0xffff];
    for (const a of edges) {
      for (const b of edges) {
        bench.set('a', a);
        bench.set('b', b);
        bench.tick();
        expect(bench.get('out')).toBe((a + b) & 0xffff);
      }
    }
  });
});
