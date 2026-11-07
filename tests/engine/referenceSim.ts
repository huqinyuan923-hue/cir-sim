/**
 * 暴力全量重算参考实现（差分对拍的"标准答案"）。
 *
 * 与引擎的刻意差异（对拍的意义所在）：
 * - 引擎：frontier 增量求值（只算输入变化的组件）+ 只合并被触碰的 net + 位技巧增量合并；
 *   参考：每趟对"全部组件"重新求值、对"全部有驱动的 net"从头按位合并（31 位逐位循环）。
 * - 引擎：数值索引 + 位运算折叠；参考：纯字符串键 + 朴素循环。
 * - 原语语义按任务书独立重写（同一数学，不同代码），因此对拍能同时抓住
 *   "调度错误"与"语义错误"两类缺陷。
 *
 * 可观测语义与引擎逐条对齐（对拍成立的前提，规则详见 REPORT.md）：
 * 组件 id 首见优先 / 未知 kind 惰性 / 断线忽略 / 固定 1 位端口表 /
 * props.width 覆盖声明宽度 / 输出清洗（缺端口、非数值按 0，再按掩码）/
 * 播种（零输入求值 + 全 net 合并一次，不计步）/ tick 循环结构与步数 /
 * setInput：只重算该组件输出并合并其 net / clockEdge：采样-提交-只刷新时钟组件。
 */

import type { ChipPort, Netlist, PortRef, TickResult } from '../../src/contract';

// ── 基础工具（独立实现） ────────────────────────────────────────────────────

function refToInt(v: number | string | undefined, fallback: number): number {
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

function refClampWidth(w: number): number {
  if (!Number.isFinite(w)) return 1;
  return Math.min(31, Math.max(1, Math.trunc(w)));
}

function refMask(w: number): number {
  return w >= 31 ? 0x7fffffff : (1 << w) - 1;
}

/** 参考实现的端口声明表（独立手写，与契约/任务书一致） */
const REF_PORTS: Record<string, ChipPort[]> = {
  AND: [
    { name: 'a', dir: 'in', width: 1 },
    { name: 'b', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  NAND: [
    { name: 'a', dir: 'in', width: 1 },
    { name: 'b', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  OR: [
    { name: 'a', dir: 'in', width: 1 },
    { name: 'b', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  XOR: [
    { name: 'a', dir: 'in', width: 1 },
    { name: 'b', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  NOT: [
    { name: 'a', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  MUX: [
    { name: 'in0', dir: 'in', width: 1 },
    { name: 'in1', dir: 'in', width: 1 },
    { name: 'sel', dir: 'in', width: 1 },
    { name: 'y', dir: 'out', width: 1 },
  ],
  CONST: [{ name: 'y', dir: 'out', width: 31 }],
  PIN_IN: [{ name: 'y', dir: 'out', width: 1 }],
  PIN_OUT: [{ name: 'a', dir: 'in', width: 1 }],
  SPLIT: [
    { name: 'bus', dir: 'in', width: 16 },
    { name: 'bit', dir: 'out', width: 1 },
  ],
  JOIN: [
    { name: 'bit', dir: 'in', width: 1 },
    { name: 'bus', dir: 'out', width: 16 },
  ],
  DFF: [
    { name: 'd', dir: 'in', width: 1 },
    { name: 'q', dir: 'out', width: 1 },
  ],
};

/** 固定 1 位端口（不随 props.width 缩放） */
const REF_FIXED1 = new Set(['SPLIT.bit', 'JOIN.bit', 'MUX.sel', 'DFF.d', 'DFF.q']);

// ── 参考求值（按任务书独立重写） ────────────────────────────────────────────

type RefProps = Readonly<Record<string, number | string>>;
type RefState = Record<string, unknown>;

function gv(inputs: Readonly<Record<string, number>>, k: string): number {
  const v = inputs[k];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}

/** 返回各输出端口的原始值（调用方负责掩码清洗） */
function refEvaluate(
  kind: string,
  inputs: Readonly<Record<string, number>>,
  state: RefState,
  props: RefProps,
): Record<string, number> {
  switch (kind) {
    case 'AND':
      return { y: gv(inputs, 'a') & gv(inputs, 'b') };
    case 'NAND':
      return { y: ~(gv(inputs, 'a') & gv(inputs, 'b')) };
    case 'OR':
      return { y: gv(inputs, 'a') | gv(inputs, 'b') };
    case 'XOR':
      return { y: gv(inputs, 'a') ^ gv(inputs, 'b') };
    case 'NOT':
      return { y: ~gv(inputs, 'a') };
    case 'MUX':
      return { y: (gv(inputs, 'sel') & 1) !== 0 ? gv(inputs, 'in1') : gv(inputs, 'in0') };
    case 'CONST':
      return { y: refToInt(props['value'], 0) };
    case 'PIN_IN': {
      const v = state['value'];
      return { y: typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0 };
    }
    case 'PIN_OUT':
      return {};
    case 'SPLIT': {
      const idx = Math.min(Math.max(refToInt(props['index'], 0), 0), 30);
      return { bit: (gv(inputs, 'bus') >>> idx) & 1 };
    }
    case 'JOIN': {
      const width = refClampWidth(refToInt(props['width'], 16));
      const high = Math.min(Math.max(refToInt(props['high'], 0), 0), width - 1);
      return { bus: (gv(inputs, 'bit') & 1) << high };
    }
    case 'DFF': {
      const q = state['q'];
      return { q: (typeof q === 'number' ? Math.trunc(q) : 0) & 1 };
    }
    default:
      return {};
  }
}

// ── 参考电路模型 ────────────────────────────────────────────────────────────

interface RefComp {
  id: string;
  kind: string;
  props: RefProps;
  ins: { port: string; net: string }[];
  outs: { port: string; net: string; mask: number }[];
  hasClock: boolean;
}

/** 参考实现的暴力仿真器 */
export class RefSim {
  private comps: RefComp[] = [];
  private compById = new Map<string, RefComp>();
  /** netKey → 驱动者列表 */
  private netDrivers = new Map<string, { comp: RefComp; port: string; mask: number }[]>();
  private netValues = new Map<string, number>();
  /** 每个组件最后一次求值的输出（与引擎的 lastOut 语义对齐） */
  private lastOut = new Map<string, Map<string, number>>();
  private states = new Map<string, RefState>();
  private dirty = new Set<string>();

  load(netlist: Netlist): void {
    // 组件表：首见优先；未知 kind 惰性
    const byId = new Map<string, RefComp>();
    for (const inst of netlist.components) {
      const ports = REF_PORTS[inst.kind];
      if (!ports || byId.has(inst.id)) continue;
      const comp: RefComp = {
        id: inst.id,
        kind: inst.kind,
        props: inst.props,
        ins: [],
        outs: [],
        hasClock: inst.kind === 'DFF',
      };
      byId.set(inst.id, comp);
      this.states.set(inst.id, refInitState(inst.kind));
    }
    // 端口与 net（字符串并查集）
    const key = (c: string, p: string): string => `${c}\u0000${p}`;
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      for (;;) {
        const up = parent.get(root);
        if (up === undefined || up === root) break;
        root = up;
      }
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    const hasPort = (cid: string, port: string): boolean => {
      const comp = byId.get(cid);
      return comp !== undefined && REF_PORTS[comp.kind]!.some((d) => d.name === port);
    };
    // 端口登记
    for (const comp of byId.values()) {
      for (const decl of REF_PORTS[comp.kind]!) {
        const k = key(comp.id, decl.name);
        const fixed = REF_FIXED1.has(`${comp.kind}.${decl.name}`);
        const width = fixed ? 1 : refClampWidth(refToInt(comp.props['width'], decl.width));
        parent.set(k, k);
        if (decl.dir === 'out') {
          const mask =
            comp.kind === 'JOIN' && decl.name === 'bus'
              ? 1 << Math.min(Math.max(refToInt(comp.props['high'], 0), 0), width - 1)
              : refMask(width);
          comp.outs.push({ port: decl.name, net: k, mask });
        } else {
          comp.ins.push({ port: decl.name, net: k });
        }
      }
    }
    // 连线合并（断线/自环忽略）
    for (const w of netlist.wires) {
      if (!hasPort(w.from.componentId, w.from.port) || !hasPort(w.to.componentId, w.to.port)) continue;
      const a = key(w.from.componentId, w.from.port);
      const b = key(w.to.componentId, w.to.port);
      if (a === b) continue;
      union(a, b);
    }
    // net 归组与驱动表
    for (const comp of byId.values()) {
      for (const side of [...comp.ins, ...comp.outs]) {
        side.net = find(side.net);
      }
      for (const out of comp.outs) {
        let list = this.netDrivers.get(out.net);
        if (!list) {
          list = [];
          this.netDrivers.set(out.net, list);
        }
        list.push({ comp, port: out.port, mask: out.mask });
      }
    }
    this.comps = [...byId.values()];
    this.compById = byId;
    // 播种（与引擎一致，不计步）：零输入求值 → lastOut → 全 net 合并 → 全部置脏
    this.netValues = new Map([...this.netDrivers.keys()].map((k) => [k, 0]));
    this.lastOut = new Map();
    for (const comp of this.comps) {
      const zero: Record<string, number> = {};
      for (const side of comp.ins) zero[side.port] = 0;
      this.lastOut.set(comp.id, this.maskOutputs(comp, refEvaluate(comp.kind, zero, this.states.get(comp.id)!, comp.props)));
    }
    this.mergeAll();
    this.dirty = new Set(this.netValues.keys());
    // 与引擎 load() 对齐：内部 settle 到不动点（同样的默认步数公式），
    // 振荡电路则停在相同的中途相位、留下相同的脏集
    this.tick(Math.max(1000, 2 * this.comps.length + 64));
  }

  /** 输出清洗：按端口掩码收回（缺端口/非数值按 0） */
  private maskOutputs(comp: RefComp, raw: Record<string, number>): Map<string, number> {
    const out = new Map<string, number>();
    for (const o of comp.outs) {
      const v = raw[o.port];
      const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
      out.set(o.port, n & o.mask);
    }
    return out;
  }

  /** 组输入 → 当前 net 值 */
  private inputsOf(comp: RefComp): Record<string, number> {
    const inputs: Record<string, number> = {};
    for (const side of comp.ins) inputs[side.port] = this.netValues.get(side.net) ?? 0;
    return inputs;
  }

  /** 全量重算所有组件输出并更新 lastOut（暴力对拍的核心） */
  private recomputeAll(inputsOverride?: Map<string, Record<string, number>>): void {
    for (const comp of this.comps) {
      const inputs = inputsOverride?.get(comp.id) ?? this.inputsOf(comp);
      this.lastOut.set(
        comp.id,
        this.maskOutputs(comp, refEvaluate(comp.kind, inputs, this.states.get(comp.id)!, comp.props)),
      );
    }
  }

  /** 全量合并所有有驱动的 net（从 lastOut 出发）；返回值发生变化的 net 集合 */
  private mergeAll(): Set<string> {
    const changed = new Set<string>();
    for (const [net, drivers] of this.netDrivers) {
      const merged = refMerge(
        drivers.map((d) => ({ mask: d.mask, value: this.lastOut.get(d.comp.id)!.get(d.port) ?? 0 })),
      );
      if (merged !== this.netValues.get(net)) {
        this.netValues.set(net, merged);
        changed.add(net);
      }
    }
    return changed;
  }

  /** 单组件刷新（setInput/clockEdge 用，与引擎 refreshComponentOutputs 对齐） */
  private refreshOne(comp: RefComp, inputs: Record<string, number>): Set<string> {
    const before = this.lastOut.get(comp.id)!;
    const fresh = this.maskOutputs(comp, refEvaluate(comp.kind, inputs, this.states.get(comp.id)!, comp.props));
    this.lastOut.set(comp.id, fresh);
    const touched = new Set<string>();
    for (const o of comp.outs) {
      if (before.get(o.port) !== fresh.get(o.port)) touched.add(o.net);
    }
    const changed = new Set<string>();
    for (const net of touched) {
      const drivers = this.netDrivers.get(net)!;
      const merged = refMerge(
        drivers.map((d) => ({ mask: d.mask, value: this.lastOut.get(d.comp.id)!.get(d.port) ?? 0 })),
      );
      if (merged !== this.netValues.get(net)) {
        this.netValues.set(net, merged);
        changed.add(net);
      }
    }
    return changed;
  }

  /** 组合传播（循环结构与引擎一致：无任务→0 步稳定；步数耗尽→振荡） */
  tick(maxSteps: number): TickResult {
    let steps = 0;
    let stable = true;
    const frontierOf = (dirty: Set<string>): RefComp[] =>
      this.comps.filter((c) => c.ins.some((side) => dirty.has(side.net)));
    let frontier = frontierOf(this.dirty);
    while (frontier.length > 0) {
      if (steps >= maxSteps) {
        stable = false;
        break;
      }
      // 暴力：全量重算 + 全量合并（不使用 frontier 过滤求值范围）
      this.recomputeAll();
      const changed = this.mergeAll();
      steps++;
      this.dirty = changed;
      frontier = frontierOf(changed);
    }
    return { stable, steps, oscillated: !stable };
  }

  /** 设置外部输入（只接受 PIN_IN 的输出端口） */
  setInput(port: PortRef, value: number): void {
    const comp = this.compById.get(port.componentId);
    if (!comp || comp.kind !== 'PIN_IN') throw new Error(`ref: ${port.componentId} 不是 PIN_IN`);
    const out = comp.outs.find((o) => o.port === port.port);
    if (!out) throw new Error(`ref: ${port.componentId} 无输出端口 ${port.port}`);
    this.states.get(comp.id)!['value'] = Math.trunc(value) & out.mask;
    // 只刷新该组件并立即写回其 net（与引擎 setInput 精确对齐）
    const changed = this.refreshOne(comp, {});
    for (const net of changed) this.dirty.add(net);
  }

  /** 时钟上升沿：先全采样、后统一提交，只刷新时钟组件（与引擎对齐） */
  clockEdge(): void {
    const clocked = this.comps.filter((c) => c.hasClock);
    const snapshots = clocked.map((c) => ({ c, d: this.netValues.get(c.ins[0]!.net) ?? 0 }));
    for (const s of snapshots) {
      this.states.get(s.c.id)!['q'] = s.d & 1;
    }
    for (const s of snapshots) {
      const changed = this.refreshOne(s.c, {});
      for (const net of changed) this.dirty.add(net);
    }
  }

  read(port: PortRef): number {
    const comp = this.compById.get(port.componentId);
    if (!comp) throw new Error(`ref: 组件不存在 ${port.componentId}`);
    const side = [...comp.ins, ...comp.outs].find((s) => s.port === port.port);
    if (!side) throw new Error(`ref: ${port.componentId} 无端口 ${port.port}`);
    return this.netValues.get(side.net) ?? 0;
  }

  /** 枚举全部已知组件的端口（对拍时逐端口比较） */
  allPorts(): PortRef[] {
    const refs: PortRef[] = [];
    for (const comp of this.comps) {
      for (const side of [...comp.ins, ...comp.outs]) {
        refs.push({ componentId: comp.id, port: side.port });
      }
    }
    return refs;
  }
}

function refInitState(kind: string): RefState {
  if (kind === 'PIN_IN') return { value: 0 };
  if (kind === 'DFF') return { q: 0 };
  return {};
}

/**
 * 参考合并：逐位线与（对拍的独立 oracle——与引擎的位技巧增量合并完全不同构）。
 * 某位被多个驱动覆盖时取按位与；无任何驱动覆盖的位为 0。
 */
function refMerge(contribs: { mask: number; value: number }[]): number {
  let result = 0;
  for (let bit = 0; bit < 31; bit++) {
    const m = 1 << bit;
    let and = 1;
    let covered = false;
    for (const c of contribs) {
      if ((c.mask & m) !== 0) {
        and &= (c.value >>> bit) & 1;
        covered = true;
      }
    }
    if (covered && and !== 0) result |= m;
  }
  return result;
}
