/**
 * 网表构建：把契约的 Netlist（组件 + 显式端口到端口连线）编译成引擎内部的
 * "扁平电路"——端口表、net 划分（并查集）、驱动关系，以及全部静态校验诊断。
 *
 * 分网规则：wire 是端口到端口的无向连接；连通的端口属于同一个 net。
 * net 编号取该连通块内最小端口序号，保证对同一网表构建结果完全确定。
 *
 * 多驱动合并的"驱动掩码"规则（核心决策，详见 REPORT.md）：
 * - 常规输出端口：掩码 = 端口宽度的全部位；
 * - JOIN 输出：掩码 = 1 << high（只驱动它摆放的那一位），
 *   因此"多条 JOIN 拼总线"是合法拓扑，不触发多驱动冲突。
 * - 同一 net 的多个驱动按位做"线与"合并；仅当某一位被两个驱动写成不同值时才算冲突。
 */

import type { ChipBehavior, ComponentInstance, Diagnostic, Netlist, PortRef } from '../contract';
import { isSingleBitPort, maskOfWidth, toInt, widthOf } from './primitives';

/** 编译后的端口 */
export interface BuiltPort {
  componentId: string;
  /** 所属组件在 comps 数组中的下标 */
  compIndex: number;
  port: string;
  dir: 'in' | 'out';
  /** 生效宽度：props.width 覆盖声明宽度；固定 1 位端口除外 */
  width: number;
  /** 端口全局序号（同时也是数组的下标） */
  index: number;
  /** 所属 net 编号 */
  net: number;
  /** 输出端口的驱动掩码 */
  mask: number;
  /** 仅输出端口：是所属组件 outPorts 的第几个 */
  outSlot: number;
}

/** 编译后的组件 */
export interface BuiltComponent {
  id: string;
  kind: string;
  instance: ComponentInstance;
  behavior: ChipBehavior;
  index: number;
  inPorts: BuiltPort[];
  outPorts: BuiltPort[];
  /** 输入端口名列表（与 inNets 一一对应，evaluate 时组装 inputs 用） */
  inNames: string[];
  /** 输入端口所在 net 列表（与 inNames 一一对应） */
  inNets: number[];
}

/** 编译后的 net */
export interface BuiltNet {
  id: number;
  ports: number[];
  wires: string[];
  /** 驱动该 net 的输出端口序号（构建顺序，即组件加载顺序） */
  drivers: number[];
  /** 读取该 net 的输入端口序号 */
  sinks: number[];
}

export interface BuiltCircuit {
  comps: BuiltComponent[];
  ports: BuiltPort[];
  nets: BuiltNet[];
  /** 组件 id → 下标（重复 id 只保留首个） */
  compById: Map<string, number>;
  /** 端口键 `${compIndex}:${portName}` → 端口序号 */
  portIndex: Map<string, number>;
  /** 带有 onClockEdge 的组件下标列表（clockEdge 遍历用） */
  clockedComps: number[];
}

export function portKey(compIndex: number, port: string): string {
  return `${compIndex}:${port}`;
}

/** 计算 JOIN 输出端口的驱动掩码：只驱动第 high 位（收敛在总线宽度内） */
function joinMask(props: Readonly<Record<string, number | string>>, width: number): number {
  const high = Math.min(Math.max(toInt(props['high'], 0), 0), width - 1);
  return 1 << high;
}

/** 组件级临时结构 */
interface CompDraft {
  id: string;
  kind: string;
  instance: ComponentInstance;
  behavior: ChipBehavior;
  index: number;
  ports: { name: string; dir: 'in' | 'out'; width: number; mask: number }[];
}

export interface BuildResult {
  circuit: BuiltCircuit;
  diagnostics: Diagnostic[];
}

/**
 * 构建电路并做全部静态校验。
 * 注意：本函数不做任何传播（纯结构），load() 之后再走 createRuntime + propagate。
 */
export function buildCircuit(
  netlist: Netlist,
  behaviors: ReadonlyMap<string, ChipBehavior>,
): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const compById = new Map<string, number>();
  const drafts: CompDraft[] = [];

  // ── 1. 组件表：重复 id 保留首个；未知 kind 的组件不参与构建（保持惰性） ──
  netlist.components.forEach((inst, i) => {
    const behavior = behaviors.get(inst.kind);
    if (!behavior) {
      diagnostics.push({
        level: 'error',
        kind: 'unknown-kind',
        message: `未知芯片类型 "${inst.kind}"（组件 ${inst.id}），该组件不参与仿真`,
        componentIds: [inst.id],
      });
      return;
    }
    if (compById.has(inst.id)) {
      diagnostics.push({
        level: 'error',
        kind: 'conflict',
        message: `组件 id 重复："${inst.id}"（第 ${i + 1} 个定义被忽略，保留首个）`,
        componentIds: [inst.id],
      });
      return;
    }
    compById.set(inst.id, drafts.length);
    const ports: CompDraft['ports'] = [];
    const seen = new Set<string>();
    for (const decl of behavior.ports) {
      if (seen.has(decl.name)) continue; // 行为声明里的重复端口名：防御性跳过
      seen.add(decl.name);
      const width = isSingleBitPort(inst.kind, decl.name)
        ? 1
        : widthOf(inst.props, decl.width);
      const mask =
        decl.dir === 'out' && inst.kind === 'JOIN' && decl.name === 'bus'
          ? joinMask(inst.props, width)
          : maskOfWidth(width);
      ports.push({ name: decl.name, dir: decl.dir, width, mask });
    }
    drafts.push({ id: inst.id, kind: inst.kind, instance: inst, behavior, index: drafts.length, ports });
  });

  // ── 2. 端口表（outSlot 必须是"输出端口中的序号"，与运行时 lastOut 对齐） ──
  const ports: BuiltPort[] = [];
  const portIndex = new Map<string, number>();
  const outCounters = new Map<number, number>();
  for (const draft of drafts) {
    draft.ports.forEach((decl) => {
      const index = ports.length;
      let outSlot = -1;
      if (decl.dir === 'out') {
        outSlot = outCounters.get(draft.index) ?? 0;
        outCounters.set(draft.index, outSlot + 1);
      }
      portIndex.set(portKey(draft.index, decl.name), index);
      ports.push({
        componentId: draft.id,
        compIndex: draft.index,
        port: decl.name,
        dir: decl.dir,
        width: decl.width,
        index,
        net: -1,
        mask: decl.mask,
        outSlot,
      });
    });
  }

  // ── 3. 连线校验 + 并查集分网 ──
  const parent = ports.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  const seenWireIds = new Set<string>();
  for (const wire of netlist.wires) {
    if (seenWireIds.has(wire.id)) {
      diagnostics.push({
        level: 'warning',
        kind: 'conflict',
        message: `连线 id 重复："${wire.id}"（重复连线被忽略）`,
        wireIds: [wire.id],
      });
      continue;
    }
    seenWireIds.add(wire.id);
    const a = resolveEndpoint(wire.from, compById, portIndex);
    const b = resolveEndpoint(wire.to, compById, portIndex);
    if (a === undefined || b === undefined) {
      const bad = a === undefined ? wire.from : wire.to;
      diagnostics.push({
        level: 'error',
        kind: 'floating',
        message: `连线 "${wire.id}" 的端点 ${bad.componentId}.${bad.port} 不存在（断线）`,
        wireIds: [wire.id],
        componentIds: [bad.componentId],
      });
      continue;
    }
    if (a === b) {
      diagnostics.push({
        level: 'warning',
        kind: 'floating',
        message: `连线 "${wire.id}" 两端是同一端口（环引用，无连接效果）`,
        wireIds: [wire.id],
      });
      continue;
    }
    union(a, b);
  }

  // ── 4. 归组 net（root = 连通块内最小端口序号，结果确定） ──
  const netPorts = new Map<number, number[]>();
  for (let i = 0; i < ports.length; i++) {
    const root = find(i);
    let list = netPorts.get(root);
    if (!list) {
      list = [];
      netPorts.set(root, list);
    }
    list.push(i);
  }
  const nets: BuiltNet[] = [];
  const netIdByRoot = new Map<number, number>();
  for (const [root, members] of netPorts) {
    const id = nets.length;
    netIdByRoot.set(root, id);
    for (const pi of members) ports[pi]!.net = id;
    nets.push({
      id,
      ports: members,
      wires: [],
      drivers: members.filter((pi) => ports[pi]!.dir === 'out'),
      sinks: members.filter((pi) => ports[pi]!.dir === 'in'),
    });
  }

  // net 归属 wires（便于诊断携带 wireIds；环引用/断线 wire 不属于任何 net）
  for (const wire of netlist.wires) {
    const a = resolveEndpoint(wire.from, compById, portIndex);
    if (a === undefined) continue;
    const b = resolveEndpoint(wire.to, compById, portIndex);
    if (b === undefined || a === b) continue;
    const net = nets[netIdByRoot.get(find(a))!]!;
    if (!net.wires.includes(wire.id)) net.wires.push(wire.id);
  }

  // ── 5. 组件级 net 视图（evaluate 时组装 inputs） ──
  const comps: BuiltComponent[] = drafts.map((draft) => {
    const inPorts: BuiltPort[] = [];
    const outPorts: BuiltPort[] = [];
    for (const decl of draft.ports) {
      const pi = portIndex.get(portKey(draft.index, decl.name))!;
      const built = ports[pi]!;
      if (decl.dir === 'in') inPorts.push(built);
      else outPorts.push(built);
    }
    return {
      id: draft.id,
      kind: draft.kind,
      instance: draft.instance,
      behavior: draft.behavior,
      index: draft.index,
      inPorts,
      outPorts,
      inNames: inPorts.map((pt) => pt.port),
      inNets: inPorts.map((pt) => pt.net),
    };
  });

  // ── 6. 静态诊断：无任何驱动的 net → floating（warning） ──
  for (const net of nets) {
    if (net.drivers.length === 0) {
      diagnostics.push({
        level: 'warning',
        kind: 'floating',
        message: `net（${describePorts(net, ports)}）无任何驱动，值恒为 0`,
        componentIds: uniqueCompIds(net.sinks, ports),
        wireIds: net.wires,
      });
    }
  }

  const clockedComps = comps.filter((c) => typeof c.behavior.onClockEdge === 'function').map((c) => c.index);

  return {
    circuit: { comps, ports, nets, compById, portIndex, clockedComps },
    diagnostics,
  };
}

/** 解析连线端点：组件未知或端口未知都返回 undefined */
function resolveEndpoint(
  ref: PortRef,
  compById: Map<string, number>,
  portIndex: Map<string, number>,
): number | undefined {
  const ci = compById.get(ref.componentId);
  if (ci === undefined) return undefined;
  return portIndex.get(portKey(ci, ref.port));
}

function describePorts(net: BuiltNet, ports: BuiltPort[]): string {
  return net.ports.map((pi) => `${ports[pi]!.componentId}.${ports[pi]!.port}`).join(' — ');
}

function uniqueCompIds(portIndices: number[], ports: BuiltPort[]): string[] {
  const ids: string[] = [];
  for (const pi of portIndices) {
    const id = ports[pi]!.componentId;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 纯校验入口（不构建运行时）：与 load() 用同一套规则 */
export function validateNetlist(
  netlist: Netlist,
  behaviors: ReadonlyMap<string, ChipBehavior>,
): Diagnostic[] {
  return buildCircuit(netlist, behaviors).diagnostics;
}
