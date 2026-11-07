/**
 * MockEngine —— 满足 SimEngine 契约的开发测试用引擎（零依赖）
 *
 * 语义约定（与画布渲染约定一致）：
 * - read() 返回 0/1；无驱动（floating）返回 -1；
 * - 冲突网络所有相关端口读到 0，并由 diagnostics 报 conflict；
 * - tick 迭代组合传播至稳定；超过 maxSteps 判振荡（标志保持到 reset/load/下次成功 tick）。
 *
 * 内置原语：INPUT / OUTPUT / AND / OR / XOR / NOT / DFF / CLK。
 * INPUT 的输出由 setInput 驱动；CLK 输出由引擎内部时钟计数驱动（props.period 为半周期沿数）。
 */

import type {
  BehaviorState,
  ChipBehavior,
  ChipPort,
  ComponentInstance,
  Diagnostic,
  Netlist,
  PortRef,
  SimEngine,
  TickResult,
} from '../contract.js';
import { portKey } from '../geometry/wirepath.js';

/** 端口→网络映射：netId 用其成员端口 key 的字典序最小者 */
interface NetGraph {
  /** portKey → netId */
  portNet: Map<string, string>;
  /** netId → 成员 portKey 列表 */
  members: Map<string, string[]>;
  /** netId → 驱动该网的 out 端口（componentId:port） */
  drivers: Map<string, string[]>;
}

export class MockEngine implements SimEngine {
  private netlist: Netlist = { components: [], wires: [] };
  private readonly behaviors = new Map<string, ChipBehavior>();
  /** INPUT 组件输出值（componentId → 0/1） */
  private readonly inputValues = new Map<string, number>();
  /** 网络当前值（netId → -1/0/1） */
  private netValues = new Map<string, number>();
  /** 时序组件状态（componentId → BehaviorState） */
  private seqState = new Map<string, BehaviorState>();
  private graph: NetGraph = { portNet: new Map(), members: new Map(), drivers: new Map() };
  private clockCount = 0;
  private oscillatedFlag = false;
  /** 冲突网络集合（load/registerBehavior 时静态检测） */
  private conflictNets = new Set<string>();
  /** 组件 id 索引（load 时重建，read() O(1)） */
  private compIndex = new Map<string, ComponentInstance>();

  constructor() {
    this.registerDefaults();
  }

  /* --------------------------- 行为注册 --------------------------- */

  registerBehavior(kind: string, behavior: ChipBehavior): void {
    this.behaviors.set(kind, behavior);
    this.conflictNets = this.detectConflicts(); // 新行为可能改变端口方向 → 重检冲突
  }

  private registerDefaults(): void {
    const p = (name: string, dir: 'in' | 'out'): ChipPort => ({ name, dir, width: 1 });
    this.behaviors.set('INPUT', { ports: [p('OUT', 'out')], evaluate: () => ({}) });
    this.behaviors.set('OUTPUT', { ports: [p('IN', 'in')], evaluate: () => ({}) });
    this.behaviors.set('AND', {
      ports: [p('A', 'in'), p('B', 'in'), p('OUT', 'out')],
      evaluate: (i) => ({ OUT: (i.A ?? 0) & (i.B ?? 0) }),
    });
    this.behaviors.set('OR', {
      ports: [p('A', 'in'), p('B', 'in'), p('OUT', 'out')],
      evaluate: (i) => ({ OUT: (i.A ?? 0) | (i.B ?? 0) }),
    });
    this.behaviors.set('XOR', {
      ports: [p('A', 'in'), p('B', 'in'), p('OUT', 'out')],
      evaluate: (i) => ({ OUT: (i.A ?? 0) ^ (i.B ?? 0) }),
    });
    this.behaviors.set('NOT', {
      ports: [p('A', 'in'), p('OUT', 'out')],
      evaluate: (i) => ({ OUT: (i.A ?? 0) ^ 1 }),
    });
    this.behaviors.set('DFF', {
      ports: [p('D', 'in'), p('CLK', 'in'), p('Q', 'out')],
      initState: () => ({ q: 0 }),
      evaluate: (_i, s) => ({ Q: s.q as number }),
      onClockEdge: (i, s) => {
        s.q = i.D;
      },
    });
    this.behaviors.set('CLK', { ports: [p('OUT', 'out')], evaluate: () => ({}) });
  }

  /* ----------------------------- 网络 ----------------------------- */

  private buildGraph(): void {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    // 注册全部端口
    for (const comp of this.netlist.components) {
      const b = this.behaviors.get(comp.kind);
      if (!b) continue;
      for (const port of b.ports) {
        const key = portKey(comp.id, port.name);
        parent.set(key, key);
      }
    }
    for (const w of this.netlist.wires) {
      const a = portKey(w.from.componentId, w.from.port);
      const b = portKey(w.to.componentId, w.to.port);
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      union(a, b);
    }
    const portNet = new Map<string, string>();
    const members = new Map<string, string[]>();
    const drivers = new Map<string, string[]>();
    for (const key of parent.keys()) {
      const root = find(key);
      portNet.set(key, root);
      if (!members.has(root)) members.set(root, []);
      members.get(root)!.push(key);
    }
    for (const [net, keys] of members) {
      for (const key of keys) {
        const cid = key.slice(0, key.lastIndexOf(':'));
        const pname = key.slice(key.lastIndexOf(':') + 1);
        const comp = this.netlist.components.find((c) => c.id === cid);
        if (!comp) continue;
        const b = this.behaviors.get(comp.kind);
        const port = b?.ports.find((pt) => pt.name === pname);
        if (port?.dir === 'out') {
          if (!drivers.has(net)) drivers.set(net, []);
          drivers.get(net)!.push(key);
        }
      }
    }
    this.graph = { portNet, members, drivers };
    this.conflictNets = this.detectConflicts();
  }

  private detectConflicts(): Set<string> {
    const conflicts = new Set<string>();
    for (const [net, drivers] of this.graph.drivers) {
      if (drivers.length >= 2) conflicts.add(net);
    }
    return conflicts;
  }

  /* --------------------------- SimEngine --------------------------- */

  load(netlist: Netlist): void {
    this.netlist = structuredClone(netlist);
    this.compIndex = new Map();
    for (const c of this.netlist.components) this.compIndex.set(c.id, c);
    this.buildGraph();
    this.seqState = new Map();
    this.clockCount = 0;
    this.oscillatedFlag = false;
    // 网络值清零（floating 标 -1，读端口时再算）
    this.netValues = new Map();
    // 移除已不存在组件的输入值（保留存活 INPUT 的设定）
    const alive = new Set(this.netlist.components.map((c) => c.id));
    for (const id of [...this.inputValues.keys()]) {
      if (!alive.has(id)) this.inputValues.delete(id);
    }
  }

  reset(): void {
    this.seqState = new Map();
    this.clockCount = 0;
    this.oscillatedFlag = false;
    this.netValues = new Map();
    // 重新传播一次，得到复位后的稳定值（组合网络立即可见；输入设定保留）
    this.tick();
  }

  setInput(port: PortRef, value: number): void {
    this.inputValues.set(port.componentId, value ? 1 : 0);
  }

  read(port: PortRef): number {
    const comp = this.compIndex.get(port.componentId);
    if (!comp) return -1;
    if (comp.kind === 'INPUT' && port.port === 'OUT') {
      return this.inputValues.get(comp.id) ?? 0;
    }
    const net = this.graph.portNet.get(portKey(port.componentId, port.port));
    if (!net) return -1;
    const v = this.netValues.get(net);
    return v === undefined ? -1 : v;
  }

  tick(maxSteps: number = 100): TickResult {
    this.oscillatedFlag = false;
    let steps = 0;
    let changed = true;
    while (changed && steps < maxSteps) {
      changed = false;
      steps++;
      const next = new Map(this.netValues);
      for (const comp of this.netlist.components) {
        const b = this.behaviors.get(comp.kind);
        if (!b) continue;
        // 输入：in 端口所在网络值（floating → 0）
        const inputs: Record<string, number> = {};
        for (const port of b.ports) {
          if (port.dir !== 'in') continue;
          const net = this.graph.portNet.get(portKey(comp.id, port.name));
          const v = net !== undefined ? this.netValues.get(net) : undefined;
          inputs[port.name] = v === undefined || v < 0 ? 0 : v;
        }
        // 输出
        let outs: Record<string, number>;
        if (comp.kind === 'INPUT') {
          outs = { OUT: this.inputValues.get(comp.id) ?? 0 };
        } else if (comp.kind === 'CLK') {
          const period = Math.max(1, Number(comp.props['period'] ?? 2));
          outs = { OUT: this.clockCount % (2 * period) < period ? 1 : 0 };
        } else {
          const state = this.seqState.get(comp.id) ?? b.initState?.(comp.props) ?? {};
          outs = b.evaluate(inputs, state, comp.props);
        }
        for (const port of b.ports) {
          if (port.dir !== 'out') continue;
          const net = this.graph.portNet.get(portKey(comp.id, port.name));
          if (net === undefined) continue;
          const v = outs[port.name] ?? 0;
          const cur = next.get(net);
          if (cur === undefined) {
            // 首次驱动：初始化网络（0 值不触发下一轮迭代）
            next.set(net, v);
            if (v !== 0) changed = true;
          } else if (cur !== v) {
            next.set(net, v);
            changed = true;
          }
        }
      }
      this.netValues = next;
    }
    const stable = !changed;
    const result: TickResult = { stable, steps, oscillated: !stable };
    if (!stable) this.oscillatedFlag = true;
    return result;
  }
  clockEdge(): void {
    this.clockCount++;
    for (const comp of this.netlist.components) {
      const b = this.behaviors.get(comp.kind);
      if (!b?.onClockEdge) continue;
      const inputs: Record<string, number> = {};
      for (const port of b.ports) {
        if (port.dir !== 'in') continue;
        const net = this.graph.portNet.get(portKey(comp.id, port.name));
        const v = net !== undefined ? this.netValues.get(net) : undefined;
        inputs[port.name] = v === undefined || v < 0 ? 0 : v;
      }
      const state = this.seqState.get(comp.id) ?? b.initState?.(comp.props) ?? {};
      b.onClockEdge(inputs, state, comp.props);
      this.seqState.set(comp.id, state);
    }
  }

  diagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    // unknown-kind
    for (const comp of this.netlist.components) {
      if (!this.behaviors.has(comp.kind)) {
        out.push({
          level: 'error',
          kind: 'unknown-kind',
          message: `未知组件类型：${comp.kind}（id=${comp.id}）`,
          componentIds: [comp.id],
        });
      }
    }
    // conflict
    for (const net of this.conflictNets) {
      const drivers = this.graph.drivers.get(net) ?? [];
      const compIds = drivers.map((k) => k.slice(0, k.lastIndexOf(':')));
      const wireIds = this.wiresOnNet(net);
      out.push({
        level: 'error',
        kind: 'conflict',
        message: `多个输出驱动同一网络（${compIds.join(', ')}）`,
        componentIds: [...new Set(compIds)],
        wireIds,
      });
    }
    // floating：无驱动的网络上的 in 端口 / 连线
    for (const [net, members] of this.graph.members) {
      const hasDriver = (this.graph.drivers.get(net)?.length ?? 0) > 0;
      if (hasDriver) continue;
      const wireIds = this.wiresOnNet(net);
      const compIds = new Set<string>();
      for (const key of members) {
        const cid = key.slice(0, key.lastIndexOf(':'));
        const pname = key.slice(key.lastIndexOf(':') + 1);
        const comp = this.netlist.components.find((c) => c.id === cid);
        const b = comp ? this.behaviors.get(comp.kind) : undefined;
        const port = b?.ports.find((pt) => pt.name === pname);
        if (port?.dir === 'in') compIds.add(cid);
      }
      if (wireIds.length > 0) {
        out.push({
          level: 'warning',
          kind: 'floating',
          message: `悬空网络（无驱动）`,
          componentIds: [...compIds],
          wireIds,
        });
      } else {
        for (const cid of compIds) {
          out.push({
            level: 'warning',
            kind: 'floating',
            message: `输入悬空（未连线）`,
            componentIds: [cid],
          });
        }
      }
    }
    // oscillation（粘滞）
    if (this.oscillatedFlag) {
      out.push({ level: 'warning', kind: 'oscillation', message: '检测到振荡（传播未收敛）' });
    }
    return out;
  }

  private wiresOnNet(net: string): string[] {
    const ids: string[] = [];
    for (const w of this.netlist.wires) {
      const a = this.graph.portNet.get(portKey(w.from.componentId, w.from.port));
      const b = this.graph.portNet.get(portKey(w.to.componentId, w.to.port));
      if (a === net || b === net) ids.push(w.id);
    }
    return ids;
  }
}
