/**
 * 模糊测试的随机网表与操作序列生成器（种子确定性：同种子必得同结果）。
 *
 * 覆盖面设计：
 * - 全部内置 kind + 少量未知 kind（走惰性路径）
 * - 位宽混合（1/2/4/16），SPLIT/JOIN 的 index/high 覆盖边界内外的值
 * - 连线端点在全部端口中随机取（自然产生 out-out 多驱动、in-in 悬空、组合环）
 * - 少量"幽灵端点"（不存在的组件/端口 → 断线路径）
 * - 操作序列：setInput / tick（maxSteps 有大有小，制造中途态）/ clockEdge
 */

import type { Netlist, PortRef } from '../../src/contract';

/** mulberry32：小型确定性 PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FuzzOp =
  | { kind: 'set'; port: PortRef; value: number; pinWidth: number }
  | { kind: 'tick'; maxSteps: number }
  | { kind: 'clock' };

export interface FuzzCase {
  netlist: Netlist;
  ops: FuzzOp[];
}

/** kind → [输入端口, 输出端口]（生成器自己维护，独立于引擎与参考实现） */
const GEN_PORTS: Record<string, { ins: string[]; outs: string[] }> = {
  AND: { ins: ['a', 'b'], outs: ['y'] },
  NAND: { ins: ['a', 'b'], outs: ['y'] },
  OR: { ins: ['a', 'b'], outs: ['y'] },
  XOR: { ins: ['a', 'b'], outs: ['y'] },
  NOT: { ins: ['a'], outs: ['y'] },
  MUX: { ins: ['in0', 'in1', 'sel'], outs: ['y'] },
  CONST: { ins: [], outs: ['y'] },
  PIN_IN: { ins: [], outs: ['y'] },
  PIN_OUT: { ins: ['a'], outs: [] },
  SPLIT: { ins: ['bus'], outs: ['bit'] },
  JOIN: { ins: ['bit'], outs: ['bus'] },
  DFF: { ins: ['d'], outs: ['q'] },
};

interface GenComp {
  id: string;
  kind: string;
  props: Record<string, number | string>;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function genComps(rng: () => number, maxComponents: number): GenComp[] {
  const comps: GenComp[] = [];
  const gateKinds = ['AND', 'NAND', 'OR', 'XOR', 'NOT', 'MUX'] as const;
  let pi = 0;
  // 外部输入 pin：1~3 个（保证操作序列有事可做）
  const pinCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < pinCount; i++) {
    comps.push({ id: `pin${i}`, kind: 'PIN_IN', props: {} });
  }
  const target = 4 + Math.floor(rng() * (maxComponents - 4));
  while (comps.length < target) {
    const roll = rng();
    if (roll < 0.55) {
      const kind = pick(rng, gateKinds);
      const width = pick(rng, [1, 1, 1, 2, 4, 16]);
      comps.push({ id: `c${comps.length}`, kind, props: { width } });
    } else if (roll < 0.68) {
      comps.push({ id: `c${comps.length}`, kind: 'DFF', props: {} });
    } else if (roll < 0.76) {
      comps.push({ id: `c${comps.length}`, kind: 'CONST', props: { value: Math.floor(rng() * 32) } });
    } else if (roll < 0.86) {
      const width = pick(rng, [2, 4, 16]);
      const index = Math.floor(rng() * (width + 2)) - 1; // 含越界
      comps.push({ id: `c${comps.length}`, kind: 'SPLIT', props: { width, index } });
    } else if (roll < 0.95) {
      const width = pick(rng, [2, 4, 16]);
      const high = Math.floor(rng() * (width + 1)); // 含越界
      comps.push({ id: `c${comps.length}`, kind: 'JOIN', props: { width, high } });
    } else if (roll < 0.98) {
      comps.push({ id: `c${comps.length}`, kind: 'PIN_OUT', props: {} });
    } else {
      comps.push({ id: `c${comps.length}`, kind: 'Mystery', props: {} }); // 未知 kind
    }
  }
  void pi;
  return comps;
}

export function genFuzzCase(
  seed: number,
  opts: { maxComponents?: number; wireFactor?: number; opsCount?: number; ghostRate?: number } = {},
): FuzzCase {
  const rng = mulberry32(seed);
  const comps = genComps(rng, opts.maxComponents ?? 26);
  const wireFactor = opts.wireFactor ?? 1.4;
  const ghostRate = opts.ghostRate ?? 0.06;

  // 端点池：全部实际端口（dir 混合，自然产生多驱动与悬空）
  interface Endpoint {
    c: string;
    p: string;
  }
  const endpoints: Endpoint[] = [];
  for (const comp of comps) {
    const model = GEN_PORTS[comp.kind];
    if (!model) continue; // 未知 kind（Mystery）：无端口可连
    for (const p of model.ins) endpoints.push({ c: comp.id, p });
    for (const p of model.outs) endpoints.push({ c: comp.id, p });
  }

  const wires: Netlist['wires'] = [];
  const wireCount = Math.round(comps.length * wireFactor);
  for (let i = 0; i < wireCount; i++) {
    const mk = (): Endpoint => {
      if (rng() < ghostRate) {
        // 幽灵端点：组件或端口不存在
        return rng() < 0.5
          ? { c: `ghost${Math.floor(rng() * 3)}`, p: 'y' }
          : { c: pick(rng, comps).id, p: 'nope' };
      }
      return pick(rng, endpoints);
    };
    const from = mk();
    let to = mk();
    // 少量真实自环（同端口两端）走 netlist 校验路径，这里排除完全相同的端点对
    if (from.c === to.c && from.p === to.p) to = pick(rng, endpoints);
    wires.push({
      id: `w${i}`,
      from: { componentId: from.c, port: from.p },
      to: { componentId: to.c, port: to.p },
    });
  }

  const netlist: Netlist = {
    // 键序与契约类型声明一致（id/kind/pos/props），保证序列化字节级可复现
    components: comps.map((c) => ({ id: c.id, kind: c.kind, pos: { x: 0, y: 0 }, props: c.props })),
    wires,
  };

  // 操作序列
  const pins = comps
    .filter((c) => c.kind === 'PIN_IN')
    .map((c) => ({ port: { componentId: c.id, port: 'y' } as PortRef }));
  const ops: FuzzOp[] = [];
  const opsCount = opts.opsCount ?? 16;
  for (let i = 0; i < opsCount; i++) {
    const roll = rng();
    if (roll < 0.55) {
      ops.push({ kind: 'set', port: pick(rng, pins).port, value: Math.floor(rng() * 4), pinWidth: 1 });
    } else if (roll < 0.85) {
      ops.push({ kind: 'tick', maxSteps: pick(rng, [8, 64, 256]) });
    } else {
      ops.push({ kind: 'clock' });
    }
  }
  return { netlist, ops };
}
