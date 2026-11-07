/**
 * M3 · 子电路展开器：复合芯片 = 网表模板 + PIN_IN/PIN_OUT 边界。
 *
 * 模板约定：
 * - 模板是普通 Netlist，其内部的 PIN_IN 组件（props.name = 端口名）声明一个输入端口，
 *   PIN_OUT 同理声明一个输出端口；实例端口名即 props.name。
 * - expand(root, templates) 把 root 中所有 kind 命中模板的组件递归替换为模板内容，
 *   产出"原语 + 原生芯片混合"的扁平网表，直接喂 engine.load()。
 * - 根网表自身的 PIN_IN/PIN_OUT 是对外接口，作为真实组件保留；模板内部的 PIN 是
 *   宏端口：组件被消除，所有引用它的连线端点改接到其所在网段的真实端点上。
 *
 * 算法（全局网段归并，两步）：
 * 1. 递归收集：组件全部前缀化；实例端口引用 (inst, x) 改写为对应边界 pin 节点
 *    （pin 组件的已前缀 id + 对外端口）。模板内连线与上层连线因此进入同一端点空间。
 * 2. 全局并查集：把全部连线端点按连线归并成网段。pin 节点所在网段若含真实组件
 *    端点，则把引用该 pin 的连线端点统一改接到该网段的代表端点（引擎按连线并查
 *    集合并 net，多端接入同一代表端点即同网段，语义严格等价）；网段无真实端点
 *    （纯悬空端口）则丢弃相关连线，悬空交给引擎的 floating 诊断。
 *
 * 错误（throw Error，中文消息）：
 * - 模板循环引用：展开栈中重复出现同一 kind（A→B→A 或 A→A）；
 * - 边界端口对位失败：连线引用了实例上不存在的端口；
 * - 模板边界端口重名；边界 PIN 缺 props.name。
 *
 * 已知限制（见 REPORT.md）：模板实例的 props 不透传到模板内部（模板组件用自身 props）。
 */

import type { ComponentInstance, Netlist, PortRef, Wire } from '../contract';

/** 模板边界 pin：pinId = pin 组件的已前缀 id（连线端点以它为别名节点） */
interface PinInfo {
  pinId: string;
  /** pin 的对外端口名：PIN_IN 用 'y'，PIN_OUT 用 'a' */
  port: 'y' | 'a';
}

interface Accum {
  components: ComponentInstance[];
  /** 端点已改写（实例端口 → pin 节点）的全局连线集 */
  wires: Wire[];
  /** 全部模板 pin 节点：pinId → info */
  pins: Map<string, PinInfo>;
}

function isBoundaryPin(kind: string): boolean {
  return kind === 'PIN_IN' || kind === 'PIN_OUT';
}

/**
 * 递归收集一层网表：组件与连线全部进入 acc（前缀化 + 实例端口改写为 pin 节点）。
 * @param isRoot 根网表的 PIN 保留为真实组件；模板层的 PIN 登记为宏端口节点
 * @returns 本层 boundary（端口名 → pin），供上层实例端口改写
 */
function collect(
  nl: Netlist,
  prefix: string,
  isRoot: boolean,
  templates: Record<string, Netlist>,
  stack: string[],
  acc: Accum,
): Map<string, PinInfo> {
  const boundary = new Map<string, PinInfo>();
  /** 实例 id → 该实例（子层）的 boundary */
  const instanceBoundary = new Map<string, Map<string, PinInfo>>();

  // ── 组件 ────────────────────────────────────────────────────────────────
  for (const comp of nl.components) {
    const cid = prefix + comp.id;
    if (isBoundaryPin(comp.kind)) {
      const name = comp.props['name'];
      if (typeof name !== 'string' || name === '') {
        throw new Error(`展开器：${isRoot ? '根网表' : '模板'}边界 PIN "${cid}" 缺少 props.name`);
      }
      if (isRoot) {
        acc.components.push({ id: cid, kind: comp.kind, pos: { ...comp.pos }, props: { ...comp.props } });
        continue;
      }
      if (boundary.has(name)) {
        throw new Error(`展开器：模板边界端口重名 "${name}"（组件 ${boundary.get(name)!.pinId} 与 ${cid}）`);
      }
      const info: PinInfo = { pinId: cid, port: comp.kind === 'PIN_IN' ? 'y' : 'a' };
      boundary.set(name, info);
      acc.pins.set(cid, info);
      continue;
    }
    const tpl = templates[comp.kind];
    if (tpl) {
      if (stack.includes(comp.kind)) {
        throw new Error(`展开器：模板循环引用 ${[...stack, comp.kind].join(' → ')}`);
      }
      stack.push(comp.kind);
      instanceBoundary.set(comp.id, collect(tpl, `${cid}/`, false, templates, stack, acc));
      stack.pop();
      continue;
    }
    acc.components.push({ id: cid, kind: comp.kind, pos: { ...comp.pos }, props: { ...comp.props } });
  }

  // ── 连线（本层）：实例端口引用 → pin 节点；其余加前缀 ──────────────────
  const rewrite = (ep: PortRef): PortRef => {
    const ib = instanceBoundary.get(ep.componentId);
    if (ib) {
      const pin = ib.get(ep.port);
      if (!pin) {
        throw new Error(`展开器：边界端口对位失败——实例 "${ep.componentId}" 没有端口 "${ep.port}"`);
      }
      return { componentId: pin.pinId, port: pin.port };
    }
    return { componentId: prefix + ep.componentId, port: ep.port };
  };
  for (const w of nl.wires) {
    acc.wires.push({ id: prefix + w.id, from: rewrite(w.from), to: rewrite(w.to) });
  }

  return boundary;
}

/** 端点键：`${componentId}::${port}` */
function keyOf(ep: PortRef): string {
  return `${ep.componentId}::${ep.port}`;
}

/**
 * 递归展开：root 中所有命中 templates 的组件被模板内容替换，直至只剩
 * 原语 / 原生芯片 + 根层 PIN_IN/PIN_OUT。纯函数，不改输入。
 */
export function expand(root: Netlist, templates: Record<string, Netlist>): Netlist {
  const acc: Accum = { components: [], wires: [], pins: new Map() };
  collect(root, '', true, templates, [], acc);

  // ── 全局并查集：连线端点 → 网段 ─────────────────────────────────────────
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // pin 的对外端口只有一个（y 或 a），端点键统一用 pinId::port
  const pinPortOf = (pinId: string): string => acc.pins.get(pinId)?.port ?? 'y';

  for (const w of acc.wires) {
    const a = w.from;
    const b = w.to;
    const ak = acc.pins.has(a.componentId) ? `${a.componentId}::${pinPortOf(a.componentId)}` : keyOf(a);
    const bk = acc.pins.has(b.componentId) ? `${b.componentId}::${pinPortOf(b.componentId)}` : keyOf(b);
    union(ak, bk);
  }

  // 网段根 → 代表端点（该网段任一真实组件端点；pin 不是组件，不能当代表）
  const realIds = new Set(acc.components.map((c) => c.id));
  const repOfRoot = new Map<string, PortRef>();
  for (const w of acc.wires) {
    for (const ep of [w.from, w.to]) {
      if (realIds.has(ep.componentId)) {
        const root = find(keyOf(ep));
        if (!repOfRoot.has(root)) repOfRoot.set(root, ep);
      }
    }
  }

  // ── 输出：pin 端点改接网段代表；无代表的网段（纯悬空端口）丢线 ──────────
  const wires: Wire[] = [];
  for (const w of acc.wires) {
    const pts: (PortRef | null)[] = [];
    for (const ep of [w.from, w.to]) {
      if (realIds.has(ep.componentId)) {
        pts.push(ep);
        continue;
      }
      // pin 节点（或其别名引用）
      const rep = repOfRoot.get(find(keyOf(ep)));
      pts.push(rep ?? null);
    }
    const [a, b] = pts;
    if (!a || !b) continue; // 某端悬空：整条丢弃（引擎对剩余悬空输入报 floating 警告）
    if (a.componentId === b.componentId && a.port === b.port) continue; // 改接后自环：冗余
    wires.push({ id: w.id, from: a, to: b });
  }

  return { components: acc.components, wires };
}
