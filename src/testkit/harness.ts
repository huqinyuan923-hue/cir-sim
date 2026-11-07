/**
 * 黄金向量对拍 harness。
 *
 * 三种向量格式（与 nand-computer SPEC 一致，见 golden/*.json）：
 * - comb：{ in, out }——组合芯片，setInput → tick → 断言；
 * - clocked：{ set, out, outAfter }——时序芯片，set → tick → 断言 out → clockEdge → tick → 断言 outAfter；
 * - computer-trace：整机向量，在 tests/computer.golden.test.ts 单独处理。
 *
 * 被测芯片通过"芯片测试台"网表接入引擎：
 *   每个输入端口挂一个 PIN_IN（id = in_<port>），每个输出端口挂一个 PIN_OUT（id = out_<port>）。
 * 这样对拍全程走契约公开 API（setInput/tick/clockEdge/read），与画布/真引擎的使用方式完全一致。
 */

import type { ChipBehavior, ChipPort, Netlist, PortRef, SimEngine } from '../contract';

/** 被测芯片实例 id */
export const DUT_ID = 'dut';

export interface ChipBench {
  engine: SimEngine;
  /** 驱动被测芯片某输入端口 */
  set(name: string, value: number): void;
  /** 读被测芯片某输出端口 */
  get(name: string): number;
  tick(): { stable: boolean; steps: number; oscillated: boolean };
  clockEdge(): void;
  /** 被测芯片某输入端口的 PortRef（高级用法） */
  inputRef(name: string): PortRef;
}

/** 为一颗芯片搭建测试台网表并载入引擎 */
export function buildChipBench(
  makeEngine: () => SimEngine,
  behavior: ChipBehavior,
  opts?: { props?: Record<string, number | string> },
): ChipBench {
  const engine = makeEngine();
  engine.registerBehavior(DUT_ID, behavior);
  const components: Netlist['components'] = [
    { id: DUT_ID, kind: DUT_ID, pos: { x: 0, y: 0 }, props: opts?.props ?? {} },
  ];
  const wires: Netlist['wires'] = [];
  let n = 0;
  for (const pt of behavior.ports) {
    if (pt.dir === 'in') {
      // 芯片输入端口：挂 PIN_IN 驱动（契约的外部输入唯一入口）。
      // props.width 覆盖 PIN_IN 声明宽度（引擎动态宽度约定），否则 16 位输入被截成 1 位。
      const id = `in_${pt.name}`;
      components.push({
        id,
        kind: 'PIN_IN',
        pos: { x: -100, y: n * 30 },
        props: { name: pt.name, width: pt.width },
      });
      wires.push({ id: `w${n++}`, from: { componentId: id, port: 'y' }, to: { componentId: DUT_ID, port: pt.name } });
    } else {
      // 芯片输出端口：挂 PIN_OUT 观察
      const id = `out_${pt.name}`;
      components.push({ id, kind: 'PIN_OUT', pos: { x: 100, y: n * 30 }, props: { name: pt.name } });
      wires.push({ id: `w${n++}`, from: { componentId: DUT_ID, port: pt.name }, to: { componentId: id, port: 'a' } });
    }
  }
  engine.load({ components, wires });
  return {
    engine,
    set(name, value) {
      engine.setInput({ componentId: `in_${name}`, port: 'y' }, value);
    },
    get(name) {
      return engine.read({ componentId: `out_${name}`, port: 'a' });
    },
    tick() {
      return engine.tick();
    },
    clockEdge() {
      engine.clockEdge();
    },
    inputRef(name) {
      return { componentId: `in_${name}`, port: 'y' };
    },
  };
}

// ── 黄金向量文件 ────────────────────────────────────────────────────────────

export interface CombCase {
  in: Record<string, number>;
  out: Record<string, number>;
  comment?: string;
}

export interface ClockedCase {
  set: Record<string, number>;
  out: Record<string, number>;
  /** 缺省（或 tick=false）表示本用例只读回不打时钟沿 */
  outAfter?: Record<string, number>;
  tick?: boolean;
  comment?: string;
}

export type GoldenFile =
  | { chip: string; kind: 'comb'; cases: CombCase[] }
  | { chip: string; kind: 'clocked'; cases: ClockedCase[] };

/** 断言辅助：格式化向量不匹配的失败信息 */
export function expectGoldenOut(
  what: string,
  chip: string,
  index: number,
  expected: Record<string, number>,
  actual: Record<string, number>,
  comment?: string,
): void {
  for (const [port, want] of Object.entries(expected)) {
    const got = actual[port];
    if (got !== want) {
      throw new Error(
        `${chip} ${what} #${index}${comment ? `（${comment}）` : ''}：端口 ${port} 期望 ${want}，实际 ${got}`,
      );
    }
  }
}

/**
 * 组合向量对拍：逐用例 setInput → tick → 断言 out。
 * 返回执行的用例数（测试里做规模断言，防止向量文件被换成空集后测试静默通过）。
 */
export function runCombGolden(bench: ChipBench, golden: { chip: string } & { kind: 'comb'; cases: CombCase[] }): number {
  const inputs = Object.keys(golden.cases[0]?.in ?? {});
  const outputs = Object.keys(golden.cases[0]?.out ?? {});
  golden.cases.forEach((c, i) => {
    for (const name of inputs) bench.set(name, c.in[name] ?? 0);
    bench.tick();
    const actual: Record<string, number> = {};
    for (const name of outputs) actual[name] = bench.get(name);
    expectGoldenOut('comb', golden.chip, i, c.out, actual, c.comment);
  });
  return golden.cases.length;
}

/**
 * 时序向量对拍：逐用例 set → tick → 断言 out → clockEdge → tick → 断言 outAfter。
 * 每个用例继承上一用例的状态（向量本身就是按时间顺序录制的连续操作序列）。
 */
export function runClockedGolden(
  bench: ChipBench,
  golden: { chip: string } & { kind: 'clocked'; cases: ClockedCase[] },
): number {
  const inputs = Object.keys(golden.cases[0]?.set ?? {});
  golden.cases.forEach((c, i) => {
    for (const name of inputs) bench.set(name, c.set[name] ?? 0);
    bench.tick();
    const before: Record<string, number> = {};
    for (const name of Object.keys(c.out)) before[name] = bench.get(name);
    expectGoldenOut('out', golden.chip, i, c.out, before, c.comment);
    const doEdge = c.outAfter !== undefined && c.tick !== false;
    if (doEdge) {
      bench.clockEdge();
      bench.tick();
      const after: Record<string, number> = {};
      for (const name of Object.keys(c.outAfter!)) after[name] = bench.get(name);
      expectGoldenOut('outAfter', golden.chip, i, c.outAfter!, after, c.comment);
    }
  });
  return golden.cases.length;
}

/** 端口构造小工具 */
export function p(name: string, dir: 'in' | 'out', width: number): ChipPort {
  return { name, dir, width };
}
