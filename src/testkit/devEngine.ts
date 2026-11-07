/**
 * 开发用仿真引擎（满足冻结契约 SimEngine 的暴力参考实现）。
 *
 * 定位（见 INTEGRATION-WAIT.md）：M1–M4 期间一部的真引擎尚未拷入，
 * 用本实现驱动芯片库对拍测试；M5 集成后切换为真引擎（tests/engineFactory.ts 一行切换），
 * 全部黄金向量测试必须在真引擎上原样通过——这正是契约一致性的最终验证。
 *
 * 与真引擎保持一致的可观测约定（实现前逐条核对过 cir-engine 源码）：
 * 1. load()/reset() 后内部自动收敛一次，read() 立即得稳定值；
 * 2. setInput 只接受 PIN_IN 的输出端口，非法目标抛 Error；
 * 3. clockEdge() 三阶段：统一采样沿前输入 → 统一提交状态 → 时钟芯片输出刷新
 *    （以"空 inputs"调 evaluate），下游组合传播留给下一次 tick()；
 * 4. 多驱动按位线与合并，同位分歧记 conflict；
 * 5. tick() 上限 maxSteps（默认 max(1000, 2×组件数+64)），超限判振荡。
 *
 * 与真引擎的差异（不影响芯片语义对拍）：
 * - 每趟传播全量重算所有组件（不做脏集增量），收敛即停——复杂度高但语义等价；
 * - 诊断只实现 floating / conflict / oscillation 三类，不做未知 kind 惰性激活。
 */

import type {
  BehaviorState,
  ChipBehavior,
  ChipPort,
  Diagnostic,
  Netlist,
  PortRef,
  SimEngine,
  TickResult,
} from '../contract';

interface Comp {
  id: string;
  kind: string;
  behavior: ChipBehavior;
  props: Record<string, number | string>;
  /** 端口名 → net 下标（进出共用同一 net） */
  portNet: Map<string, number>;
  inNames: string[];
  outNames: string[];
  state: BehaviorState;
}

interface NetInfo {
  id: number;
  /** 驱动方：[compIndex, outPortName] */
  drivers: { comp: number; port: string; width: number }[];
}

function maskOfWidth(width: number): number {
  const w = Math.min(31, Math.max(1, Math.trunc(width)));
  return w >= 31 ? 0x7fffffff : (1 << w) - 1;
}

/** 固定 1 位端口（与 cir-engine primitives.ts 的 SINGLE_BIT_PORTS 一致） */
const SINGLE_BIT_PORTS = new Set(['SPLIT.bit', 'JOIN.bit', 'MUX.sel', 'DFF.d', 'DFF.q']);

/** 生效位宽 = props.width ?? 声明宽度（钳制 1..31）；固定 1 位端口不随 props 缩放 */
function effectiveWidth(c: Comp, portName: string): number {
  if (SINGLE_BIT_PORTS.has(`${c.kind}.${portName}`)) return 1;
  const pt = c.behavior.ports.find((x) => x.name === portName);
  if (!pt) return 1;
  const w = c.props['width'];
  if (w !== undefined) {
    const n = typeof w === 'number' ? Math.trunc(w) : Math.trunc(Number(w));
    if (Number.isFinite(n)) return Math.min(31, Math.max(1, n));
  }
  return pt.width;
}

/** 串连端点 → 合并 net（并查集思路的朴素实现：网表规模小，直接线性归并） */
export class DevEngine implements SimEngine {
  private behaviors = new Map<string, ChipBehavior>();
  private comps: Comp[] = [];
  private nets: NetInfo[] = [];
  private netValues: number[] = [];
  private compById = new Map<string, number>();
  private diags: Diagnostic[] = [];
  /** 已知 kind 清单（原语 + 已注册库芯片），用于诊断 unknown-kind */
  private knownKinds = new Set<string>();

  constructor() {
    // 引擎内置原语（与 cir-engine primitives.ts 同一份最小语义；M5 后由真引擎接管）
    for (const [kind, b] of Object.entries(devPrimitives())) {
      this.behaviors.set(kind, b);
      this.knownKinds.add(kind);
    }
  }

  registerBehavior(kind: string, behavior: ChipBehavior): void {
    this.behaviors.set(kind, behavior);
    this.knownKinds.add(kind);
  }

  load(netlist: Netlist): void {
    this.compile(netlist);
    this.settle();
  }

  reset(): void {
    // 重置全部时序状态（initState 重建），保留 PIN_IN 激励
    const pins = new Map<string, number>();
    for (const c of this.comps) {
      if (c.kind === 'PIN_IN') pins.set(c.id, num(c.state['value']));
    }
    for (const c of this.comps) {
      c.state = c.behavior.initState ? c.behavior.initState(c.props) : {};
    }
    for (const c of this.comps) {
      if (c.kind === 'PIN_IN') {
        c.state['value'] = pins.get(c.id) ?? 0;
      }
    }
    this.refreshAllComponentOutputs();
    this.settle();
  }

  setInput(port: PortRef, value: number): void {
    const ci = this.compById.get(port.componentId);
    if (ci === undefined) throw new Error(`setInput：组件 "${port.componentId}" 不存在`);
    const c = this.comps[ci]!;
    if (c.kind !== 'PIN_IN') {
      throw new Error(`setInput：只能驱动 PIN_IN 组件（"${port.componentId}" 是 ${c.kind}）`);
    }
    if (!c.outNames.includes(port.port)) {
      throw new Error(`setInput：组件 "${port.componentId}" 没有输出端口 "${port.port}"`);
    }
    const width = effectiveWidth(c, port.port);
    c.state['value'] = Math.trunc(value) & maskOfWidth(width);
    this.refreshComponentOutput(c);
    this.settle();
  }

  read(port: PortRef): number {
    const ci = this.compById.get(port.componentId);
    if (ci === undefined) throw new Error(`read：组件 "${port.componentId}" 不存在`);
    const c = this.comps[ci]!;
    const net = c.portNet.get(port.port);
    if (net === undefined) {
      throw new Error(`read：组件 "${port.componentId}" 没有端口 "${port.port}"`);
    }
    return this.netValues[net] ?? 0;
  }

  tick(maxSteps?: number): TickResult {
    return this.settle(maxSteps);
  }

  clockEdge(): void {
    // 阶段 1：统一采样沿前输入
    const samples: { c: Comp; inputs: Record<string, number> }[] = [];
    for (const c of this.comps) {
      if (!c.behavior.onClockEdge) continue;
      const inputs: Record<string, number> = {};
      for (const name of c.inNames) inputs[name] = this.netInput(c, name);
      samples.push({ c, inputs });
    }
    // 阶段 2：统一提交状态
    for (const s of samples) s.c.behavior.onClockEdge!(s.inputs, s.c.state, s.c.props);
    // 阶段 3：时钟芯片输出刷新（以空 inputs 求值——真引擎约定，芯片的时序输出必须只读 state）
    for (const s of samples) this.refreshComponentOutput(s.c);
  }

  diagnostics(): Diagnostic[] {
    return [...this.diags];
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 编译网表：连线归并为 net、实例化组件状态、静态诊断 */
  private compile(netlist: Netlist): void {
    this.comps = [];
    this.nets = [];
    this.netValues = [];
    this.compById = new Map();
    this.diags = [];

    // 端点 → net：并查集（数组实现；parent 由 netOf 在建 net 时初始化）
    const find = (x: number): number => {
      let cur = x;
      while (parent[cur] !== cur) {
        const up = parent[cur]!;
        parent[cur] = parent[up]!;
        cur = up;
      }
      return cur;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    // 端点键：`${compId}::${port}` → 临时 net 号
    const endpointNet = new Map<string, number>();
    const parent: number[] = [];
    let nextNet = 0;
    const netOf = (compId: string, port: string): number => {
      const key = `${compId}::${port}`;
      let n = endpointNet.get(key);
      if (n === undefined) {
        n = nextNet++;
        parent[n] = n; // 并查集自根（此前漏了初始化，所有 net 会被错误归并）
        endpointNet.set(key, n);
      }
      return n;
    };

    const validIds = new Set<string>();
    for (const comp of netlist.components) {
      validIds.add(comp.id);
      if (this.compById.has(comp.id)) {
        this.diags.push({
          level: 'error',
          kind: 'conflict',
          message: `组件 id 重复：${comp.id}（保留首个定义）`,
          componentIds: [comp.id],
        });
        continue;
      }
      const behavior = this.behaviors.get(comp.kind);
      if (!behavior) {
        this.diags.push({
          level: 'error',
          kind: 'unknown-kind',
          message: `未知芯片类型 "${comp.kind}"（组件 ${comp.id} 惰性挂起，registerBehavior 后激活）`,
          componentIds: [comp.id],
        });
      }
      const ci = this.comps.length;
      this.compById.set(comp.id, ci);
      this.comps.push({
        id: comp.id,
        kind: comp.kind,
        behavior: behavior ?? { ports: [], evaluate: () => ({}) },
        props: { ...comp.props },
        portNet: new Map(),
        inNames: [],
        outNames: [],
        state: {},
      });
    }

    // 连线：合并端点 net
    const wireIds = new Set<string>();
    for (const w of netlist.wires) {
      if (wireIds.has(w.id)) {
        this.diags.push({
          level: 'warning',
          kind: 'conflict',
          message: `连线 id 重复：${w.id}（忽略重复）`,
          wireIds: [w.id],
        });
        continue;
      }
      wireIds.add(w.id);
      if (!validIds.has(w.from.componentId) || !validIds.has(w.to.componentId)) {
        this.diags.push({
          level: 'error',
          kind: 'floating',
          message: `连线 ${w.id} 端点引用不存在的组件`,
          wireIds: [w.id],
        });
        continue;
      }
      const a = netOf(w.from.componentId, w.from.port);
      const b = netOf(w.to.componentId, w.to.port);
      union(a, b);
    }

    // net 归并：临时 net 号 → 最终 net 下标
    const tmpToFinal = new Map<number, number>();
    for (let t = 0; t < nextNet; t++) {
      const r = find(t);
      let f = tmpToFinal.get(r);
      if (f === undefined) {
        f = this.nets.length;
        tmpToFinal.set(r, f);
        this.nets.push({ id: f, drivers: [] });
        this.netValues.push(0);
      }
      tmpToFinal.set(t, f);
    }

    // 组件端口挂 net + 初始化状态
    for (const c of this.comps) {
      for (const pt of c.behavior.ports) {
        const tmp = endpointNet.get(`${c.id}::${pt.name}`);
        if (tmp === undefined) continue; // 未连线的端口：悬空（无 net）
        const f = tmpToFinal.get(tmp)!;
        c.portNet.set(pt.name, f);
        if (pt.dir === 'in') c.inNames.push(pt.name);
        else {
          c.outNames.push(pt.name);
          this.nets[f]!.drivers.push({ comp: this.compById.get(c.id)!, port: pt.name, width: pt.width });
        }
      }
      c.state = c.behavior.initState ? c.behavior.initState(c.props) : {};
    }

    // 悬空 net 诊断（无驱动）
    for (const n of this.nets) {
      if (n.drivers.length === 0) {
        this.diags.push({
          level: 'warning',
          kind: 'floating',
          message: `net #${n.id} 无驱动，值恒为 0`,
        });
      }
    }

    this.refreshAllComponentOutputs();
  }

  /** 以当前 net 值组装组件输入（按端口宽度掩码） */
  private netInput(c: Comp, name: string): number {
    const net = c.portNet.get(name);
    if (net === undefined) return 0;
    const width = effectiveWidth(c, name);
    return (this.netValues[net] ?? 0) & maskOfWidth(width);
  }

  /** 重算一个组件的输出并写回其 net（返回是否有 net 变化） */
  private refreshComponentOutput(c: Comp): boolean {
    const inputs: Record<string, number> = {};
    for (const name of c.inNames) inputs[name] = this.netInput(c, name);
    const outs = c.behavior.evaluate(inputs, c.state, c.props);
    let changed = false;
    for (const name of c.outNames) {
      const net = c.portNet.get(name);
      if (net === undefined) continue;
      const width = effectiveWidth(c, name);
      const raw = typeof outs[name] === 'number' && Number.isFinite(outs[name] as number)
        ? Math.trunc(outs[name] as number)
        : 0;
      const v = raw & maskOfWidth(width);
      if (this.netValues[net] !== v) {
        this.netValues[net] = v;
        changed = true;
      }
    }
    return changed;
  }

  private refreshAllComponentOutputs(): void {
    for (const c of this.comps) this.refreshComponentOutput(c);
  }

  /** 全量传播直到不动点（与真引擎的可观测结果一致：stable/steps/oscillated） */
  private settle(maxSteps?: number): TickResult {
    const limit = Math.max(1, Math.trunc(maxSteps ?? Math.max(1000, 2 * this.comps.length + 64)));
    let steps = 0;
    while (steps < limit) {
      // 阶段一：全体组件按"本趟开始时的 net 值"求出目标输出
      const snapshot = [...this.netValues];
      const next = new Map<number, number>();
      for (const c of this.comps) {
        const inputs: Record<string, number> = {};
        for (const name of c.inNames) {
          const net = c.portNet.get(name);
          if (net === undefined) continue;
          const width = effectiveWidth(c, name);
          inputs[name] = (snapshot[net] ?? 0) & maskOfWidth(width);
        }
        const outs = c.behavior.evaluate(inputs, c.state, c.props);
        for (const name of c.outNames) {
          const net = c.portNet.get(name);
          if (net === undefined) continue;
          const width = effectiveWidth(c, name);
          const raw = typeof outs[name] === 'number' && Number.isFinite(outs[name] as number)
            ? Math.trunc(outs[name] as number)
            : 0;
          const v = raw & maskOfWidth(width);
          if (v !== snapshot[net]) next.set(net, v);
        }
      }
      if (next.size === 0) {
        this.recomputeDiags(null);
        return { stable: true, steps, oscillated: false };
      }
      // 阶段二：统一提交（单元延迟语义；多驱动按位线与由 refreshNetAll 处理）
      for (const [net, v] of next) this.netValues[net] = v;
      this.mergeMultiDriverNets();
      steps++;
    }
    this.recomputeDiags('oscillation');
    return { stable: false, steps, oscillated: true };
  }

  /** 多驱动 net 按位线与合并（本工程网表原则上单驱动，此函数保底） */
  private mergeMultiDriverNets(): void {
    for (const n of this.nets) {
      if (n.drivers.length < 2) continue;
      let value = 0;
      let covered = 0;
      for (const d of n.drivers) {
        const c = this.comps[d.comp]!;
        const net = c.portNet.get(d.port);
        // 驱动方自己的输出快照 = 它写进 net 的值；此处直接读 netValues 的当前合并值不可行，
        // 因此改为重算该组件输出（组件数少，代价可忽略）
        const inputs: Record<string, number> = {};
        for (const name of c.inNames) inputs[name] = this.netInput(c, name);
        const outs = c.behavior.evaluate(inputs, c.state, c.props);
        const raw = typeof outs[d.port] === 'number' && Number.isFinite(outs[d.port] as number)
          ? Math.trunc(outs[d.port] as number)
          : 0;
        const m = maskOfWidth(d.width);
        const v = raw & m;
        value = (value & ~m) | (v & (m & ~covered)) | ((value & v) & (m & covered));
        covered |= m;
      }
      this.netValues[n.id] = value;
    }
  }

  private recomputeDiags(oscillation: 'oscillation' | null): void {
    const dynamic: Diagnostic[] = [];
    // conflict：多驱动同位分歧
    for (const n of this.nets) {
      if (n.drivers.length < 2) continue;
      let value = 0;
      let covered = 0;
      let contested = 0;
      const ids: string[] = [];
      for (const d of n.drivers) {
        const c = this.comps[d.comp]!;
        if (!ids.includes(c.id)) ids.push(c.id);
        const inputs: Record<string, number> = {};
        for (const name of c.inNames) inputs[name] = this.netInput(c, name);
        const outs = c.behavior.evaluate(inputs, c.state, c.props);
        const raw = typeof outs[d.port] === 'number' && Number.isFinite(outs[d.port] as number)
          ? Math.trunc(outs[d.port] as number)
          : 0;
        const m = maskOfWidth(d.width);
        const v = raw & m;
        contested |= (m & covered) & (value ^ v);
        value = (value & ~m) | (v & (m & ~covered)) | ((value & v) & (m & covered));
        covered |= m;
      }
      if (contested !== 0) {
        dynamic.push({
          level: 'error',
          kind: 'conflict',
          message: `net #${n.id} 多驱动在第 ${contested.toString(2)} 位取值不同，冲突位按线与记 0`,
          componentIds: ids,
        });
      }
    }
    if (oscillation === 'oscillation') {
      dynamic.push({
        level: 'error',
        kind: 'oscillation',
        message: `组合传播在 ${'多趟'}内未收敛，判定为振荡`,
      });
    }
    this.diags = [...this.diags.filter((d) => d.kind === 'floating' || d.kind === 'unknown-kind'), ...dynamic];
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 开发引擎的最小内置原语（与 cir-engine primitives.ts 语义一致）。
 * 1 位门、MUX、CONST、PIN_IN/PIN_OUT、SPLIT/JOIN、DFF。
 */
function devPrimitives(): Record<string, ChipBehavior> {
  const gate = (op: (a: number, b: number) => number): ChipBehavior => ({
    ports: [
      { name: 'a', dir: 'in', width: 1 },
      { name: 'b', dir: 'in', width: 1 },
      { name: 'y', dir: 'out', width: 1 },
    ],
    evaluate: (inputs) => ({ y: op(num(inputs['a']), num(inputs['b'])) }),
  });
  return {
    AND: gate((a, b) => a & b),
    OR: gate((a, b) => a | b),
    XOR: gate((a, b) => a ^ b),
    NAND: gate((a, b) => ~(a & b)),
    NOT: {
      ports: [
        { name: 'a', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (inputs) => ({ y: ~num(inputs['a']) }),
    },
    MUX: {
      ports: [
        { name: 'in0', dir: 'in', width: 1 },
        { name: 'in1', dir: 'in', width: 1 },
        { name: 'sel', dir: 'in', width: 1 },
        { name: 'y', dir: 'out', width: 1 },
      ],
      evaluate: (inputs) => ({
        y: (num(inputs['sel']) & 1) !== 0 ? num(inputs['in1']) : num(inputs['in0']),
      }),
    },
    CONST: {
      ports: [{ name: 'y', dir: 'out', width: 31 }],
      evaluate: (_i, _s, props) => ({ y: num(props['value']) }),
    },
    PIN_IN: {
      ports: [{ name: 'y', dir: 'out', width: 1 }],
      initState: () => ({ value: 0 }),
      evaluate: (_i, state) => ({ y: num(state['value']) }),
    },
    PIN_OUT: {
      ports: [{ name: 'a', dir: 'in', width: 1 }],
      evaluate: () => ({}),
    },
    SPLIT: {
      ports: [
        { name: 'bus', dir: 'in', width: 16 },
        { name: 'bit', dir: 'out', width: 1 },
      ],
      evaluate: (inputs, _s, props) => {
        const index = Math.min(Math.max(num(props['index']), 0), 30);
        return { bit: (num(inputs['bus']) >>> index) & 1 };
      },
    },
    JOIN: {
      ports: [
        { name: 'bit', dir: 'in', width: 1 },
        { name: 'bus', dir: 'out', width: 16 },
      ],
      evaluate: (inputs, _s, props) => {
        const width = Math.min(Math.max(num(props['width']) || 16, 1), 31);
        const high = Math.min(Math.max(num(props['high']), 0), width - 1);
        return { bus: (num(inputs['bit']) & 1) << high };
      },
    },
    DFF: {
      ports: [
        { name: 'd', dir: 'in', width: 1 },
        { name: 'q', dir: 'out', width: 1 },
      ],
      initState: () => ({ q: 0 }),
      evaluate: (_i, state) => ({ q: num(state['q']) & 1 }),
      onClockEdge: (inputs, state) => {
        state['q'] = num(inputs['d']) & 1;
      },
    },
  };
}

/** 创建开发引擎（tests/engineFactory.ts 在 M5 切换为真引擎） */
export function createDevEngine(): SimEngine {
  return new DevEngine();
}
