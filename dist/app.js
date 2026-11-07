"use strict";
(() => {
  // src/engine/events.ts
  function createRuntime(circuit) {
    const rt = {
      netValues: circuit.nets.map(() => 0),
      states: [],
      lastOut: [],
      dirty: /* @__PURE__ */ new Set()
    };
    for (const comp of circuit.comps) {
      const state = comp.behavior.initState ? comp.behavior.initState(comp.instance.props) : {};
      rt.states[comp.index] = state;
      const outs = comp.outPorts.map(() => 0);
      const inputs = {};
      for (const name of comp.inNames) inputs[name] = 0;
      const evaluated = comp.behavior.evaluate(inputs, state, comp.instance.props);
      comp.outPorts.forEach((pt, slot) => {
        outs[slot] = sanitizeOutput(evaluated[pt.port], pt);
      });
      rt.lastOut[comp.index] = outs;
    }
    return rt;
  }
  function sanitizeOutput(raw, port2) {
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
    return n & port2.mask;
  }
  function refreshComponentOutputs(circuit, rt, compIndex) {
    const comp = circuit.comps[compIndex];
    const state = rt.states[compIndex] ?? {};
    const evaluated = comp.behavior.evaluate({}, state, comp.instance.props);
    const outs = rt.lastOut[compIndex];
    const touched = /* @__PURE__ */ new Set();
    comp.outPorts.forEach((pt, slot) => {
      const v2 = sanitizeOutput(evaluated[pt.port], pt);
      if (outs[slot] !== v2) {
        outs[slot] = v2;
        touched.add(pt.net);
      }
    });
    const changed = [];
    for (const net of touched) {
      if (refreshNet(circuit, rt, net)) changed.push(net);
    }
    return changed;
  }
  function refreshNet(circuit, rt, net) {
    const info = circuit.nets[net];
    if (info.drivers.length === 0) return false;
    let value = 0;
    let covered = 0;
    for (const pi of info.drivers) {
      const port2 = circuit.ports[pi];
      const v2 = rt.lastOut[port2.compIndex][port2.outSlot] ?? 0;
      const m = port2.mask;
      value = value & ~m | v2 & (m & ~covered) | value & v2 & (m & covered);
      covered |= m;
    }
    if (rt.netValues[net] !== value) {
      rt.netValues[net] = value;
      return true;
    }
    return false;
  }
  function collectFrontier(circuit, dirty) {
    const seen = /* @__PURE__ */ new Set();
    for (const net of dirty) {
      const info = circuit.nets[net];
      if (!info) continue;
      for (const pi of info.sinks) seen.add(circuit.ports[pi].compIndex);
    }
    return [...seen];
  }
  function evaluateComponent(circuit, rt, compIndex) {
    const comp = circuit.comps[compIndex];
    const inputs = {};
    for (let i = 0; i < comp.inNames.length; i++) {
      inputs[comp.inNames[i]] = rt.netValues[comp.inNets[i]] ?? 0;
    }
    const state = rt.states[compIndex] ?? {};
    const evaluated = comp.behavior.evaluate(inputs, state, comp.instance.props);
    const outs = rt.lastOut[compIndex];
    const touched = [];
    comp.outPorts.forEach((pt, slot) => {
      const v2 = sanitizeOutput(evaluated[pt.port], pt);
      if (outs[slot] !== v2) {
        outs[slot] = v2;
        touched.push(pt.net);
      }
    });
    return touched;
  }
  function propagate(circuit, rt, maxSteps) {
    let steps = 0;
    let stable = true;
    let frontier = collectFrontier(circuit, rt.dirty);
    while (frontier.length > 0) {
      if (steps >= maxSteps) {
        stable = false;
        break;
      }
      const touched = /* @__PURE__ */ new Set();
      for (const ci of frontier) {
        for (const net of evaluateComponent(circuit, rt, ci)) touched.add(net);
      }
      const changed = /* @__PURE__ */ new Set();
      for (const net of touched) {
        if (refreshNet(circuit, rt, net)) changed.add(net);
      }
      steps++;
      rt.dirty = changed;
      frontier = collectFrontier(circuit, changed);
    }
    return { stable, steps, oscillated: !stable, frontier };
  }
  function collectDynamicDiagnostics(circuit, rt, outcome) {
    const diags = [];
    if (!circuit || !rt) return diags;
    for (const net of circuit.nets) {
      if (net.drivers.length < 2) continue;
      let value = 0;
      let covered = 0;
      let contested = 0;
      for (const pi of net.drivers) {
        const port2 = circuit.ports[pi];
        const v2 = rt.lastOut[port2.compIndex][port2.outSlot] ?? 0;
        const m = port2.mask;
        contested |= m & covered & (value ^ v2);
        value = value & ~m | v2 & (m & ~covered) | value & v2 & (m & covered);
        covered |= m;
      }
      if (contested !== 0) {
        const ids = [];
        for (const pi of net.drivers) {
          const id = circuit.ports[pi].componentId;
          if (!ids.includes(id)) ids.push(id);
        }
        diags.push({
          level: "error",
          kind: "conflict",
          message: `net\uFF08${describeNet(circuit, net.id)}\uFF09\u591A\u4E2A\u9A71\u52A8\u5728\u7B2C ${contested.toString(2)} \u4F4D\u53D6\u503C\u4E0D\u540C\uFF0C\u51B2\u7A81\u4F4D\u6309\u7EBF\u4E0E\u8BB0 0`,
          componentIds: ids,
          wireIds: net.wires
        });
      }
    }
    if (outcome && outcome.oscillated) {
      diags.push({
        level: "error",
        kind: "oscillation",
        message: `\u7EC4\u5408\u4F20\u64AD\u5728 ${outcome.steps} \u6B65\u5185\u672A\u6536\u655B\uFF0C\u5224\u5B9A\u4E3A\u632F\u8361`,
        componentIds: uniqueIds(circuit, outcome.frontier)
      });
    }
    return diags;
  }
  function describeNet(circuit, netId) {
    const info = circuit.nets[netId];
    return info.ports.map((pi) => `${circuit.ports[pi].componentId}.${circuit.ports[pi].port}`).join(" \u2014 ");
  }
  function uniqueIds(circuit, compIndices) {
    const ids = [];
    for (const ci of compIndices) {
      const id = circuit.comps[ci].id;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // src/engine/clock.ts
  function applyClockEdge(circuit, rt) {
    const samples = [];
    for (const ci of circuit.clockedComps) {
      const comp = circuit.comps[ci];
      const inputs = {};
      for (let i = 0; i < comp.inNames.length; i++) {
        inputs[comp.inNames[i]] = rt.netValues[comp.inNets[i]] ?? 0;
      }
      samples.push({ compIndex: ci, inputs });
    }
    for (const s of samples) {
      const comp = circuit.comps[s.compIndex];
      comp.behavior.onClockEdge(s.inputs, rt.states[s.compIndex], comp.instance.props);
    }
    for (const s of samples) {
      for (const net of refreshComponentOutputs(circuit, rt, s.compIndex)) {
        rt.dirty.add(net);
      }
    }
  }

  // src/engine/primitives.ts
  var MAX_WIDTH = 31;
  function clampWidth(w) {
    if (!Number.isFinite(w)) return 1;
    return Math.min(MAX_WIDTH, Math.max(1, Math.trunc(w)));
  }
  function toInt(v2, fallback) {
    if (typeof v2 === "number") {
      const n = Math.trunc(v2);
      return Number.isFinite(n) ? n : fallback;
    }
    if (typeof v2 === "string" && v2.trim() !== "") {
      const n = Math.trunc(Number(v2));
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }
  function widthOf(props, fallback = 1) {
    return clampWidth(toInt(props["width"], fallback));
  }
  var SINGLE_BIT_PORTS = /* @__PURE__ */ new Set([
    "SPLIT.bit",
    "JOIN.bit",
    "MUX.sel",
    "DFF.d",
    "DFF.q"
  ]);
  function isSingleBitPort(kind, port2) {
    return SINGLE_BIT_PORTS.has(`${kind}.${port2}`);
  }
  function maskOfWidth(width) {
    return width >= MAX_WIDTH ? 2147483647 : (1 << width) - 1;
  }
  function p(name, dir, width) {
    return { name, dir, width };
  }
  function stateNum(state, key) {
    const v2 = state[key];
    return typeof v2 === "number" && Number.isFinite(v2) ? Math.trunc(v2) : 0;
  }
  function inputNum(inputs, key) {
    const v2 = inputs[key];
    return typeof v2 === "number" && Number.isFinite(v2) ? Math.trunc(v2) : 0;
  }
  function binaryGate(op) {
    return {
      ports: [p("a", "in", 1), p("b", "in", 1), p("y", "out", 1)],
      evaluate: (inputs) => ({ y: op(inputNum(inputs, "a"), inputNum(inputs, "b")) })
    };
  }
  var PRIMITIVES = {
    // ── 二输入门 ────────────────────────────────────────────────────────────
    AND: binaryGate((a, b) => a & b),
    OR: binaryGate((a, b) => a | b),
    XOR: binaryGate((a, b) => a ^ b),
    NAND: binaryGate((a, b) => ~(a & b)),
    // 取反结果可能为负，引擎写 net 前按宽度掩码收回非负
    // ── NOT ────────────────────────────────────────────────────────────────
    NOT: {
      ports: [p("a", "in", 1), p("y", "out", 1)],
      evaluate: (inputs) => ({ y: ~inputNum(inputs, "a") })
    },
    // ── MUX：sel=0 选 in0，sel 非 0 选 in1 ─────────────────────────────────
    MUX: {
      ports: [p("in0", "in", 1), p("in1", "in", 1), p("sel", "in", 1), p("y", "out", 1)],
      evaluate: (inputs) => ({
        y: (inputNum(inputs, "sel") & 1) !== 0 ? inputNum(inputs, "in1") : inputNum(inputs, "in0")
      })
    },
    // ── CONST：恒驱动 props.value ──────────────────────────────────────────
    // 端口声明宽度取上限 31：value 自描述宽度（写 5 就输出 5）；
    // 显式 props.width 会覆盖声明宽度，把输出收窄（value 再按掩码截断）。
    CONST: {
      ports: [p("y", "out", 31)],
      evaluate: (_inputs, _state, props) => ({ y: toInt(props["value"], 0) })
    },
    // ── PIN_IN：电路对外输入口，值由 setInput 写入 state ─────────────────────
    PIN_IN: {
      ports: [p("y", "out", 1)],
      initState: () => ({ value: 0 }),
      evaluate: (_inputs, state) => ({ y: stateNum(state, "value") })
    },
    // ── PIN_OUT：电路对外输出口，仅观察（对外读它的 a 端口所在 net） ──────────
    PIN_OUT: {
      ports: [p("a", "in", 1)],
      evaluate: () => ({})
    },
    // ── SPLIT：从 bus 取第 index 位 ────────────────────────────────────────
    SPLIT: {
      ports: [p("bus", "in", 16), p("bit", "out", 1)],
      evaluate: (inputs, _state, props) => {
        const index = Math.min(Math.max(toInt(props["index"], 0), 0), 30);
        return { bit: inputNum(inputs, "bus") >>> index & 1 };
      }
    },
    // ── JOIN：把单 bit 放到 bus 的第 high 位 ───────────────────────────────
    // 说明：JOIN 的驱动掩码是特殊的（只驱动 1<<high 这一位），
    // 该规则由引擎按 kind=JOIN 特判（见 netlist.ts 的 outMask 计算），
    // 这样"两条 JOIN 拼 16 位总线"才能在不触发多驱动冲突的情况下工作。
    JOIN: {
      ports: [p("bit", "in", 1), p("bus", "out", 16)],
      evaluate: (inputs, _state, props) => {
        const width = widthOf(props, 16);
        const high = Math.min(Math.max(toInt(props["high"], 0), 0), width - 1);
        return { bus: (inputNum(inputs, "bit") & 1) << high };
      }
    },
    // ── DFF：平时 q 保持；clockEdge() 全局上升沿 q ← d ──────────────────────
    // 毛刺免疫由结构保证：传播期只可能改 d 所在 net，q 只在 onClockEdge 里采样。
    DFF: {
      ports: [p("d", "in", 1), p("q", "out", 1)],
      initState: () => ({ q: 0 }),
      evaluate: (_inputs, state) => ({ q: stateNum(state, "q") & 1 }),
      onClockEdge: (inputs, state) => {
        state["q"] = inputNum(inputs, "d") & 1;
      }
    }
  };

  // src/engine/netlist.ts
  function portKey(compIndex, port2) {
    return `${compIndex}:${port2}`;
  }
  function joinMask(props, width) {
    const high = Math.min(Math.max(toInt(props["high"], 0), 0), width - 1);
    return 1 << high;
  }
  function buildCircuit(netlist, behaviors) {
    const diagnostics = [];
    const compById = /* @__PURE__ */ new Map();
    const drafts = [];
    netlist.components.forEach((inst, i) => {
      const behavior = behaviors.get(inst.kind);
      if (!behavior) {
        diagnostics.push({
          level: "error",
          kind: "unknown-kind",
          message: `\u672A\u77E5\u82AF\u7247\u7C7B\u578B "${inst.kind}"\uFF08\u7EC4\u4EF6 ${inst.id}\uFF09\uFF0C\u8BE5\u7EC4\u4EF6\u4E0D\u53C2\u4E0E\u4EFF\u771F`,
          componentIds: [inst.id]
        });
        return;
      }
      if (compById.has(inst.id)) {
        diagnostics.push({
          level: "error",
          kind: "conflict",
          message: `\u7EC4\u4EF6 id \u91CD\u590D\uFF1A"${inst.id}"\uFF08\u7B2C ${i + 1} \u4E2A\u5B9A\u4E49\u88AB\u5FFD\u7565\uFF0C\u4FDD\u7559\u9996\u4E2A\uFF09`,
          componentIds: [inst.id]
        });
        return;
      }
      compById.set(inst.id, drafts.length);
      const ports2 = [];
      const seen = /* @__PURE__ */ new Set();
      for (const decl of behavior.ports) {
        if (seen.has(decl.name)) continue;
        seen.add(decl.name);
        const width = isSingleBitPort(inst.kind, decl.name) ? 1 : widthOf(inst.props, decl.width);
        const mask = decl.dir === "out" && inst.kind === "JOIN" && decl.name === "bus" ? joinMask(inst.props, width) : maskOfWidth(width);
        ports2.push({ name: decl.name, dir: decl.dir, width, mask });
      }
      drafts.push({ id: inst.id, kind: inst.kind, instance: inst, behavior, index: drafts.length, ports: ports2 });
    });
    const ports = [];
    const portIndex = /* @__PURE__ */ new Map();
    const outCounters = /* @__PURE__ */ new Map();
    for (const draft of drafts) {
      draft.ports.forEach((decl) => {
        const index = ports.length;
        let outSlot = -1;
        if (decl.dir === "out") {
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
          outSlot
        });
      });
    }
    const parent = ports.map((_, i) => i);
    const find = (x) => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== root) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const seenWireIds = /* @__PURE__ */ new Set();
    for (const wire of netlist.wires) {
      if (seenWireIds.has(wire.id)) {
        diagnostics.push({
          level: "warning",
          kind: "conflict",
          message: `\u8FDE\u7EBF id \u91CD\u590D\uFF1A"${wire.id}"\uFF08\u91CD\u590D\u8FDE\u7EBF\u88AB\u5FFD\u7565\uFF09`,
          wireIds: [wire.id]
        });
        continue;
      }
      seenWireIds.add(wire.id);
      const a = resolveEndpoint(wire.from, compById, portIndex);
      const b = resolveEndpoint(wire.to, compById, portIndex);
      if (a === void 0 || b === void 0) {
        const bad = a === void 0 ? wire.from : wire.to;
        diagnostics.push({
          level: "error",
          kind: "floating",
          message: `\u8FDE\u7EBF "${wire.id}" \u7684\u7AEF\u70B9 ${bad.componentId}.${bad.port} \u4E0D\u5B58\u5728\uFF08\u65AD\u7EBF\uFF09`,
          wireIds: [wire.id],
          componentIds: [bad.componentId]
        });
        continue;
      }
      if (a === b) {
        diagnostics.push({
          level: "warning",
          kind: "floating",
          message: `\u8FDE\u7EBF "${wire.id}" \u4E24\u7AEF\u662F\u540C\u4E00\u7AEF\u53E3\uFF08\u73AF\u5F15\u7528\uFF0C\u65E0\u8FDE\u63A5\u6548\u679C\uFF09`,
          wireIds: [wire.id]
        });
        continue;
      }
      union(a, b);
    }
    const netPorts = /* @__PURE__ */ new Map();
    for (let i = 0; i < ports.length; i++) {
      const root = find(i);
      let list = netPorts.get(root);
      if (!list) {
        list = [];
        netPorts.set(root, list);
      }
      list.push(i);
    }
    const nets = [];
    const netIdByRoot = /* @__PURE__ */ new Map();
    for (const [root, members] of netPorts) {
      const id = nets.length;
      netIdByRoot.set(root, id);
      for (const pi of members) ports[pi].net = id;
      nets.push({
        id,
        ports: members,
        wires: [],
        drivers: members.filter((pi) => ports[pi].dir === "out"),
        sinks: members.filter((pi) => ports[pi].dir === "in")
      });
    }
    for (const wire of netlist.wires) {
      const a = resolveEndpoint(wire.from, compById, portIndex);
      if (a === void 0) continue;
      const b = resolveEndpoint(wire.to, compById, portIndex);
      if (b === void 0 || a === b) continue;
      const net = nets[netIdByRoot.get(find(a))];
      if (!net.wires.includes(wire.id)) net.wires.push(wire.id);
    }
    const comps = drafts.map((draft) => {
      const inPorts = [];
      const outPorts = [];
      for (const decl of draft.ports) {
        const pi = portIndex.get(portKey(draft.index, decl.name));
        const built = ports[pi];
        if (decl.dir === "in") inPorts.push(built);
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
        inNets: inPorts.map((pt) => pt.net)
      };
    });
    for (const net of nets) {
      if (net.drivers.length === 0) {
        diagnostics.push({
          level: "warning",
          kind: "floating",
          message: `net\uFF08${describePorts(net, ports)}\uFF09\u65E0\u4EFB\u4F55\u9A71\u52A8\uFF0C\u503C\u6052\u4E3A 0`,
          componentIds: uniqueCompIds(net.sinks, ports),
          wireIds: net.wires
        });
      }
    }
    const clockedComps = comps.filter((c) => typeof c.behavior.onClockEdge === "function").map((c) => c.index);
    return {
      circuit: { comps, ports, nets, compById, portIndex, clockedComps },
      diagnostics
    };
  }
  function resolveEndpoint(ref, compById, portIndex) {
    const ci = compById.get(ref.componentId);
    if (ci === void 0) return void 0;
    return portIndex.get(portKey(ci, ref.port));
  }
  function describePorts(net, ports) {
    return net.ports.map((pi) => `${ports[pi].componentId}.${ports[pi].port}`).join(" \u2014 ");
  }
  function uniqueCompIds(portIndices, ports) {
    const ids = [];
    for (const pi of portIndices) {
      const id = ports[pi].componentId;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  function validateNetlist(netlist, behaviors) {
    return buildCircuit(netlist, behaviors).diagnostics;
  }

  // src/engine/EngineImpl.ts
  var EngineImpl = class {
    behaviors = /* @__PURE__ */ new Map();
    /** load 时深拷贝的原始网表（registerBehavior 触发重建时使用） */
    source = null;
    circuit = null;
    rt = null;
    staticDiags = [];
    dynamicDiags = [];
    constructor(behaviors) {
      for (const [kind, behavior] of behaviors) {
        this.behaviors.set(kind, behavior);
      }
    }
    registerBehavior(kind, behavior) {
      this.behaviors.set(kind, behavior);
      if (this.source) this.build();
    }
    load(netlist) {
      this.source = cloneNetlist(netlist);
      this.build();
    }
    reset() {
      const { circuit, rt } = this.requireState();
      const pins = [];
      for (const comp of circuit.comps) {
        if (comp.kind !== "PIN_IN") continue;
        pins.push({ compIndex: comp.index, value: rt.states[comp.index]?.["value"] ?? 0 });
      }
      this.rebuildRuntime(circuit);
      for (const pin of pins) {
        this.rt.states[pin.compIndex]["value"] = pin.value;
        refreshComponentOutputs(circuit, this.rt, pin.compIndex);
      }
      this.settle();
    }
    setInput(port2, value) {
      const { circuit, rt } = this.requireState();
      const ci = circuit.compById.get(port2.componentId);
      if (ci === void 0) {
        throw new Error(`setInput\uFF1A\u7EC4\u4EF6 "${port2.componentId}" \u4E0D\u5B58\u5728`);
      }
      const comp = circuit.comps[ci];
      if (comp.kind !== "PIN_IN") {
        throw new Error(`setInput\uFF1A\u53EA\u80FD\u9A71\u52A8 PIN_IN \u7EC4\u4EF6\uFF08"${port2.componentId}" \u662F ${comp.kind}\uFF09`);
      }
      const out = comp.outPorts.find((pt) => pt.port === port2.port);
      if (!out) {
        throw new Error(`setInput\uFF1A\u7EC4\u4EF6 "${port2.componentId}" \u6CA1\u6709\u8F93\u51FA\u7AEF\u53E3 "${port2.port}"`);
      }
      rt.states[ci]["value"] = Math.trunc(value) & out.mask;
      for (const net of refreshComponentOutputs(circuit, rt, ci)) {
        rt.dirty.add(net);
      }
      this.refreshDynamic();
    }
    read(port2) {
      const { circuit, rt } = this.requireState();
      const ci = circuit.compById.get(port2.componentId);
      if (ci === void 0) {
        throw new Error(`read\uFF1A\u7EC4\u4EF6 "${port2.componentId}" \u4E0D\u5B58\u5728`);
      }
      const pi = circuit.portIndex.get(portKey(ci, port2.port));
      if (pi === void 0) {
        throw new Error(`read\uFF1A\u7EC4\u4EF6 "${port2.componentId}" \u6CA1\u6709\u7AEF\u53E3 "${port2.port}"`);
      }
      return rt.netValues[circuit.ports[pi].net];
    }
    tick(maxSteps) {
      if (!this.circuit || !this.rt) return { stable: true, steps: 0, oscillated: false };
      const limit = Math.max(1, Math.trunc(maxSteps ?? this.defaultMaxSteps()));
      const outcome = propagate(this.circuit, this.rt, limit);
      this.dynamicDiags = collectDynamicDiagnostics(this.circuit, this.rt, outcome);
      return { stable: outcome.stable, steps: outcome.steps, oscillated: outcome.oscillated };
    }
    clockEdge() {
      if (!this.circuit || !this.rt) return;
      applyClockEdge(this.circuit, this.rt);
      this.refreshDynamic();
    }
    diagnostics() {
      return [...this.staticDiags, ...this.dynamicDiags];
    }
    /** 供同包工具（校验脚本等）复用：以当前行为表做纯校验 */
    validate(netlist) {
      return validateNetlist(netlist, this.behaviors);
    }
    // ── 内部 ────────────────────────────────────────────────────────────────
    build() {
      const { circuit, diagnostics } = buildCircuit(this.source, this.behaviors);
      this.circuit = circuit;
      this.staticDiags = diagnostics;
      this.rebuildRuntime(circuit);
      this.settle();
    }
    /** 新建运行时并把全部 net 置脏（下一步 settle 做全量传播） */
    rebuildRuntime(circuit) {
      const rt = createRuntime(circuit);
      for (let n = 0; n < circuit.nets.length; n++) refreshNet(circuit, rt, n);
      rt.dirty = new Set(circuit.nets.map((_, i) => i));
      this.rt = rt;
    }
    /** 全量传播一遍（load/reset 的内部 settle） */
    settle() {
      const { circuit, rt } = this.requireState();
      propagate(circuit, rt, this.defaultMaxSteps());
      this.refreshDynamic();
    }
    defaultMaxSteps() {
      return Math.max(1e3, 2 * (this.circuit?.comps.length ?? 0) + 64);
    }
    refreshDynamic() {
      this.dynamicDiags = collectDynamicDiagnostics(this.circuit, this.rt, null);
    }
    requireState() {
      if (!this.circuit || !this.rt) {
        throw new Error("\u5F15\u64CE\u5C1A\u672A load() \u7F51\u8868");
      }
      return { circuit: this.circuit, rt: this.rt };
    }
  };
  function cloneNetlist(netlist) {
    return {
      components: netlist.components.map((c) => ({
        id: c.id,
        kind: c.kind,
        pos: { x: c.pos.x, y: c.pos.y },
        props: { ...c.props }
      })),
      wires: netlist.wires.map((w) => ({
        id: w.id,
        from: { ...w.from },
        to: { ...w.to }
      }))
    };
  }

  // src/engine/createEngine.ts
  function createEngine() {
    const initial = Object.entries(PRIMITIVES);
    return new EngineImpl(initial);
  }

  // src/expand/expand.ts
  function isBoundaryPin(kind) {
    return kind === "PIN_IN" || kind === "PIN_OUT";
  }
  function collect(nl, prefix, isRoot, templates, stack, acc) {
    const boundary = /* @__PURE__ */ new Map();
    const instanceBoundary = /* @__PURE__ */ new Map();
    for (const comp of nl.components) {
      const cid = prefix + comp.id;
      if (isBoundaryPin(comp.kind)) {
        const name = comp.props["name"];
        if (typeof name !== "string" || name === "") {
          throw new Error(`\u5C55\u5F00\u5668\uFF1A${isRoot ? "\u6839\u7F51\u8868" : "\u6A21\u677F"}\u8FB9\u754C PIN "${cid}" \u7F3A\u5C11 props.name`);
        }
        if (isRoot) {
          acc.components.push({ id: cid, kind: comp.kind, pos: { ...comp.pos }, props: { ...comp.props } });
          continue;
        }
        if (boundary.has(name)) {
          throw new Error(`\u5C55\u5F00\u5668\uFF1A\u6A21\u677F\u8FB9\u754C\u7AEF\u53E3\u91CD\u540D "${name}"\uFF08\u7EC4\u4EF6 ${boundary.get(name).pinId} \u4E0E ${cid}\uFF09`);
        }
        const info = { pinId: cid, port: comp.kind === "PIN_IN" ? "y" : "a" };
        boundary.set(name, info);
        acc.pins.set(cid, info);
        continue;
      }
      const tpl = templates[comp.kind];
      if (tpl) {
        if (stack.includes(comp.kind)) {
          throw new Error(`\u5C55\u5F00\u5668\uFF1A\u6A21\u677F\u5FAA\u73AF\u5F15\u7528 ${[...stack, comp.kind].join(" \u2192 ")}`);
        }
        stack.push(comp.kind);
        instanceBoundary.set(comp.id, collect(tpl, `${cid}/`, false, templates, stack, acc));
        stack.pop();
        continue;
      }
      acc.components.push({ id: cid, kind: comp.kind, pos: { ...comp.pos }, props: { ...comp.props } });
    }
    const rewrite = (ep) => {
      const ib = instanceBoundary.get(ep.componentId);
      if (ib) {
        const pin = ib.get(ep.port);
        if (!pin) {
          throw new Error(`\u5C55\u5F00\u5668\uFF1A\u8FB9\u754C\u7AEF\u53E3\u5BF9\u4F4D\u5931\u8D25\u2014\u2014\u5B9E\u4F8B "${ep.componentId}" \u6CA1\u6709\u7AEF\u53E3 "${ep.port}"`);
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
  function keyOf(ep) {
    return `${ep.componentId}::${ep.port}`;
  }
  function expand(root, templates) {
    const acc = { components: [], wires: [], pins: /* @__PURE__ */ new Map() };
    collect(root, "", true, templates, [], acc);
    const parent = /* @__PURE__ */ new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      let r = x;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r);
      let c = x;
      while (c !== r) {
        const next = parent.get(c);
        parent.set(c, r);
        c = next;
      }
      return r;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const pinPortOf = (pinId) => acc.pins.get(pinId)?.port ?? "y";
    for (const w of acc.wires) {
      const a = w.from;
      const b = w.to;
      const ak = acc.pins.has(a.componentId) ? `${a.componentId}::${pinPortOf(a.componentId)}` : keyOf(a);
      const bk = acc.pins.has(b.componentId) ? `${b.componentId}::${pinPortOf(b.componentId)}` : keyOf(b);
      union(ak, bk);
    }
    const realIds = new Set(acc.components.map((c) => c.id));
    const repOfRoot = /* @__PURE__ */ new Map();
    for (const w of acc.wires) {
      for (const ep of [w.from, w.to]) {
        if (realIds.has(ep.componentId)) {
          const root2 = find(keyOf(ep));
          if (!repOfRoot.has(root2)) repOfRoot.set(root2, ep);
        }
      }
    }
    const wires = [];
    for (const w of acc.wires) {
      const pts = [];
      for (const ep of [w.from, w.to]) {
        if (realIds.has(ep.componentId)) {
          pts.push(ep);
          continue;
        }
        const rep = repOfRoot.get(find(keyOf(ep)));
        pts.push(rep ?? null);
      }
      const [a, b] = pts;
      if (!a || !b) continue;
      if (a.componentId === b.componentId && a.port === b.port) continue;
      wires.push({ id: w.id, from: a, to: b });
    }
    return { components: acc.components, wires };
  }

  // src/expand/builder.ts
  var NetlistBuilder = class {
    components = [];
    wires = [];
    seq = 0;
    ids = /* @__PURE__ */ new Set();
    wireSeq = 0;
    /** 添加组件（kind 必须是引擎原语或已注册的库芯片），返回可连线的句柄 */
    add(id, kind, props = {}) {
      const finalId = id ?? `${kind.toLowerCase()}_${this.seq++}`;
      if (this.ids.has(finalId)) throw new Error(`NetlistBuilder\uFF1A\u7EC4\u4EF6 id \u91CD\u590D "${finalId}"`);
      this.ids.add(finalId);
      this.components.push({
        id: finalId,
        kind,
        pos: { x: this.components.length % 8 * 120, y: Math.floor(this.components.length / 8) * 100 },
        props
      });
      return { componentId: finalId, ports: /* @__PURE__ */ new Map() };
    }
    /** 根层对外输入（PIN_IN，name = 对外端口名） */
    pinIn(id, name, width = 1) {
      const h = this.add(id, "PIN_IN", { name, width });
      return { componentId: h.componentId, port: "y" };
    }
    /** 根层对外观察（PIN_OUT，name = 对外端口名） */
    pinOut(id, name) {
      const h = this.add(id, "PIN_OUT", { name });
      return { componentId: h.componentId, port: "a" };
    }
    /** 连线：from 与 to 都是 PortRef */
    connect(from, to) {
      this.wires.push({ id: `w${this.wireSeq++}`, from, to });
    }
    build() {
      return { components: this.components.map((c) => ({ ...c, pos: { ...c.pos }, props: { ...c.props } })), wires: this.wires.map((w) => ({ ...w })) };
    }
  };
  function port(h, name) {
    let p3 = h.ports.get(name);
    if (!p3) {
      p3 = { componentId: h.componentId, port: name };
      h.ports.set(name, p3);
    }
    return p3;
  }

  // src/chips/bits.ts
  var W16 = 65535;
  function p2(name, dir, width) {
    return { name, dir, width };
  }
  function v(x, mask = W16) {
    const n = typeof x === "number" && Number.isFinite(x) ? Math.trunc(x) : 0;
    return n & mask;
  }
  function gate16(name, op) {
    return {
      ports: [p2("a", "in", 16), p2("b", "in", 16), p2("out", "out", 16)],
      evaluate: (inputs) => ({ out: op(v(inputs["a"]), v(inputs["b"])) })
    };
  }
  function mux16Way(name, lanes, selBits) {
    return {
      ports: [...lanes.map((l) => p2(l, "in", 16)), p2("sel", "in", selBits), p2("out", "out", 16)],
      evaluate: (inputs) => {
        const sel = v(inputs["sel"], (1 << selBits) - 1);
        return { out: v(inputs[lanes[sel] ?? lanes[0]]) };
      }
    };
  }
  function dmuxWay(name, outs, selBits) {
    return {
      ports: [p2("in", "in", 1), p2("sel", "in", selBits), ...outs.map((o) => p2(o, "out", 1))],
      evaluate: (inputs) => {
        const sel = v(inputs["sel"], (1 << selBits) - 1);
        const on = v(inputs["in"], 1);
        const result = {};
        outs.forEach((o, i) => {
          result[o] = i === sel ? on : 0;
        });
        return result;
      }
    };
  }
  function combinationalChips() {
    return {
      // ── 16 位逐位门 ──────────────────────────────────────────────────────
      AND16: gate16("AND16", (a, b) => a & b),
      OR16: gate16("OR16", (a, b) => a | b),
      XOR16: gate16("XOR16", (a, b) => a ^ b),
      NOT16: {
        ports: [p2("in", "in", 16), p2("out", "out", 16)],
        evaluate: (inputs) => ({ out: ~v(inputs["in"]) })
      },
      NEG16: {
        // 二进制补码取负：-x = ~x + 1
        ports: [p2("in", "in", 16), p2("out", "out", 16)],
        evaluate: (inputs) => ({ out: -v(inputs["in"]) & W16 })
      },
      // ── 16 位多路选择 ────────────────────────────────────────────────────
      MUX16: mux16Way("MUX16", ["a", "b"], 1),
      MUX4WAY16: mux16Way("MUX4WAY16", ["a", "b", "c", "d"], 2),
      MUX8WAY16: mux16Way("MUX8WAY16", ["a", "b", "c", "d", "e", "f", "g", "h"], 3),
      // ── DMUX 家族 ────────────────────────────────────────────────────────
      DMUX: dmuxWay("DMUX", ["a", "b"], 1),
      DMUX4WAY: dmuxWay("DMUX4WAY", ["a", "b", "c", "d"], 2),
      DMUX8WAY: dmuxWay("DMUX8WAY", ["a", "b", "c", "d", "e", "f", "g", "h"], 3),
      // ── 宽输入 / 加法器 ─────────────────────────────────────────────────
      OR8WAY: {
        ports: [p2("in", "in", 8), p2("out", "out", 1)],
        evaluate: (inputs) => ({ out: v(inputs["in"], 255) === 0 ? 0 : 1 })
      },
      HALFADDER: {
        ports: [p2("a", "in", 1), p2("b", "in", 1), p2("sum", "out", 1), p2("carry", "out", 1)],
        evaluate: (inputs) => {
          const a = v(inputs["a"], 1);
          const b = v(inputs["b"], 1);
          return { sum: a ^ b, carry: a & b };
        }
      },
      FULLADDER: {
        ports: [p2("a", "in", 1), p2("b", "in", 1), p2("c", "in", 1), p2("sum", "out", 1), p2("carry", "out", 1)],
        evaluate: (inputs) => {
          const a = v(inputs["a"], 1);
          const b = v(inputs["b"], 1);
          const c = v(inputs["c"], 1);
          return { sum: a ^ b ^ c, carry: a & b | c & (a ^ b) };
        }
      },
      ADD16: {
        // 行波进位语义在黄金向量层面对拍；这里用整数加法 + 16 位掩码（数学等价）
        ports: [p2("a", "in", 16), p2("b", "in", 16), p2("out", "out", 16)],
        evaluate: (inputs) => ({ out: v(inputs["a"]) + v(inputs["b"]) & W16 })
      },
      INC16: {
        ports: [p2("in", "in", 16), p2("out", "out", 16)],
        evaluate: (inputs) => ({ out: v(inputs["in"]) + 1 & W16 })
      }
    };
  }

  // src/chips/alu.ts
  var W162 = 65535;
  var ALU_BEHAVIOR = {
    ports: [
      { name: "x", dir: "in", width: 16 },
      { name: "y", dir: "in", width: 16 },
      { name: "zx", dir: "in", width: 1 },
      { name: "nx", dir: "in", width: 1 },
      { name: "zy", dir: "in", width: 1 },
      { name: "ny", dir: "in", width: 1 },
      { name: "f", dir: "in", width: 1 },
      { name: "no", dir: "in", width: 1 },
      { name: "out", dir: "out", width: 16 },
      { name: "zr", dir: "out", width: 1 },
      { name: "ng", dir: "out", width: 1 }
    ],
    evaluate: (inputs) => {
      let x = v(inputs["x"]);
      let y = v(inputs["y"]);
      if (v(inputs["zx"], 1)) x = 0;
      if (v(inputs["nx"], 1)) x = ~x & W162;
      if (v(inputs["zy"], 1)) y = 0;
      if (v(inputs["ny"], 1)) y = ~y & W162;
      let out = v(inputs["f"], 1) ? x + y & W162 : x & y;
      if (v(inputs["no"], 1)) out = ~out & W162;
      return { out, zr: out === 0 ? 1 : 0, ng: out >>> 15 & 1 };
    }
  };

  // src/chips/seq.ts
  function loadBit(inputs) {
    return v(inputs["load"], 1) === 1;
  }
  function makeRegister(width) {
    return {
      ports: [p2("in", "in", width), p2("load", "in", 1), p2("out", "out", width)],
      initState: () => ({ q: 0 }),
      evaluate: (_inputs, state) => ({ out: v(state["q"]) }),
      onClockEdge: (inputs, state) => {
        if (loadBit(inputs)) state["q"] = v(inputs["in"]);
      }
    };
  }
  var PC_BEHAVIOR = {
    ports: [
      p2("in", "in", 16),
      p2("load", "in", 1),
      p2("inc", "in", 1),
      p2("reset", "in", 1),
      p2("out", "out", 16)
    ],
    initState: () => ({ q: 0 }),
    evaluate: (_inputs, state) => ({ out: v(state["q"]) }),
    onClockEdge: (inputs, state) => {
      if (v(inputs["reset"], 1)) {
        state["q"] = 0;
      } else if (v(inputs["load"], 1)) {
        state["q"] = v(inputs["in"]);
      } else if (v(inputs["inc"], 1)) {
        state["q"] = v(state["q"]) + 1 & 32767;
      }
    }
  };
  function sequentialChips() {
    return {
      BIT: makeRegister(1),
      REGISTER16: makeRegister(16),
      REGISTER: makeRegister(16),
      AREGISTER: makeRegister(16),
      DREGISTER: makeRegister(16),
      PC: PC_BEHAVIOR
    };
  }

  // src/chips/handles.ts
  var romRegistry = /* @__PURE__ */ new Map();
  var ramRegistry = /* @__PURE__ */ new Map();
  var screenRegistry = /* @__PURE__ */ new Map();
  var kbdRegistry = /* @__PURE__ */ new Map();
  function adopt(registry2, id, make) {
    const found = registry2.get(id);
    if (found) return found;
    const fresh = make();
    registry2.set(id, fresh);
    return fresh;
  }
  function adoptRom(props) {
    return adopt(romRegistry, String(props["id"] ?? ""), () => ({
      words: new Array(32768).fill(0),
      lastAddr: 0
    }));
  }
  function adoptRam16K(props) {
    return adopt(ramRegistry, String(props["id"] ?? ""), () => ({
      mem: new Array(16384).fill(0),
      lastAddr: 0
    }));
  }
  function adoptScreen(props) {
    return adopt(screenRegistry, String(props["id"] ?? ""), () => ({
      words: new Array(8192).fill(0),
      lastAddr: 0
    }));
  }
  function adoptKeyboard(props) {
    return adopt(kbdRegistry, String(props["id"] ?? ""), () => ({ key: 0 }));
  }

  // src/chips/memory.ts
  function makeRam(sizeLog2, opts) {
    const size = 1 << sizeLog2;
    const addrMask = size - 1;
    return {
      ports: [
        p2("in", "in", 16),
        p2("load", "in", 1),
        p2("address", "in", sizeLog2),
        p2("out", "out", 16)
      ],
      initState: opts?.registered ? (props) => adoptRam16K(props) : () => ({ mem: new Array(size).fill(0), lastAddr: 0 }),
      evaluate: (inputs, state) => {
        const s = state;
        const addr = "address" in inputs ? v(inputs["address"], addrMask) : v(s.lastAddr, addrMask);
        s.lastAddr = addr;
        return { out: v(s.mem[addr]) };
      },
      onClockEdge: (inputs, state) => {
        const s = state;
        const addr = v(inputs["address"], addrMask);
        s.lastAddr = addr;
        if (v(inputs["load"], 1)) s.mem[addr] = v(inputs["in"]);
      }
    };
  }
  var ROM32K_BEHAVIOR = {
    ports: [p2("address", "in", 15), p2("out", "out", 16)],
    initState: (props) => adoptRom(props),
    evaluate: (inputs, state) => {
      const s = state;
      const addr = v(inputs["address"], 32767);
      return { out: v(s.words[addr]) };
    }
  };
  function memoryChips() {
    return {
      RAM8: makeRam(3),
      RAM64: makeRam(6),
      RAM512: makeRam(9),
      RAM4K: makeRam(12),
      RAM16K: makeRam(14, { registered: true }),
      ROM32K: ROM32K_BEHAVIOR
    };
  }

  // src/chips/io.ts
  var SCREEN_BEHAVIOR = {
    ports: [
      p2("in", "in", 16),
      p2("load", "in", 1),
      p2("address", "in", 13),
      p2("out", "out", 16)
    ],
    initState: (props) => adoptScreen(props),
    evaluate: (inputs, state) => {
      const s = state;
      const addr = "address" in inputs ? v(inputs["address"], 8191) : v(s.lastAddr, 8191);
      s.lastAddr = addr;
      return { out: v(s.words[addr]) };
    },
    onClockEdge: (inputs, state) => {
      const s = state;
      const addr = v(inputs["address"], 8191);
      s.lastAddr = addr;
      if (v(inputs["load"], 1)) s.words[addr] = v(inputs["in"]);
    }
  };
  var KEYBOARD_BEHAVIOR = {
    ports: [p2("out", "out", 16)],
    initState: (props) => adoptKeyboard(props),
    evaluate: (_inputs, state) => ({ out: v(state.key) })
  };
  function peripheralChips() {
    return { SCREEN: SCREEN_BEHAVIOR, KEYBOARD: KEYBOARD_BEHAVIOR };
  }

  // src/chips/memdecode.ts
  var MEMDECODE_BEHAVIOR = {
    ports: [
      p2("a", "in", 16),
      p2("isram", "out", 1),
      p2("isscr", "out", 1),
      p2("kbd", "out", 1)
    ],
    evaluate: (inputs) => {
      const a = v(inputs["a"]);
      const hi = a & 49152;
      return {
        isram: hi === 0 ? 1 : 0,
        isscr: hi === 16384 ? 1 : 0,
        kbd: a === 24576 ? 1 : 0
      };
    }
  };

  // src/chips/registerAll.ts
  function chipLibrary() {
    return {
      ...combinationalChips(),
      ALU: ALU_BEHAVIOR,
      ...sequentialChips(),
      ...memoryChips(),
      ...peripheralChips(),
      MEMDECODE: MEMDECODE_BEHAVIOR
    };
  }

  // src/hack/cpu.ts
  var CPU_KIND = "HACK_CPU";
  function buildCpuTemplate() {
    const b = new NetlistBuilder();
    const pInstr = b.pinIn("b_instr", "instr");
    const pInM = b.pinIn("b_inm", "inM");
    const pReset = b.pinIn("b_reset", "reset");
    const oPc = b.pinOut("o_pc", "pc");
    const oA = b.pinOut("o_a", "a");
    const oD = b.pinOut("o_d", "d");
    const oOutM = b.pinOut("o_outm", "outM");
    const oWriteM = b.pinOut("o_writem", "writeM");
    const bit = (i) => {
      const s = b.add(`si${i}`, "SPLIT", { index: i });
      b.connect(pInstr, port(s, "bus"));
      return port(s, "bit");
    };
    const i0 = bit(0);
    const i1 = bit(1);
    const i2 = bit(2);
    const i3 = bit(3);
    const i4 = bit(4);
    const i5 = bit(5);
    const i6 = bit(6);
    const i7 = bit(7);
    const i8 = bit(8);
    const i9 = bit(9);
    const i10 = bit(10);
    const i11 = bit(11);
    const i12 = bit(12);
    const i15 = bit(15);
    const ysel = b.add("mux_y", "MUX16");
    b.connect(i12, port(ysel, "sel"));
    b.connect(pInM, port(ysel, "b"));
    const alu = b.add("alu", "ALU");
    b.connect(port(ysel, "out"), port(alu, "y"));
    const dreg = b.add("dreg", "DREGISTER");
    b.connect(port(dreg, "out"), port(alu, "x"));
    b.connect(port(alu, "out"), port(dreg, "in"));
    const aselect = b.add("mux_ain", "MUX16");
    b.connect(i15, port(aselect, "sel"));
    b.connect(pInstr, port(aselect, "a"));
    b.connect(port(alu, "out"), port(aselect, "b"));
    const areg = b.add("areg", "AREGISTER");
    b.connect(port(aselect, "out"), port(areg, "in"));
    b.connect(port(areg, "out"), port(ysel, "a"));
    b.connect(port(areg, "out"), oA);
    const pc = b.add("pc", "PC");
    b.connect(port(areg, "out"), port(pc, "in"));
    const one = b.add("const1", "CONST", { value: 1 });
    b.connect(port(one, "y"), port(pc, "inc"));
    b.connect(pReset, port(pc, "reset"));
    b.connect(port(pc, "out"), oPc);
    const g = (id, kind) => port(b.add(id, kind), "y");
    const n15 = g("not_c", "NOT");
    b.connect(i15, { componentId: n15.componentId, port: "a" });
    const loadA = g("or_a", "OR");
    b.connect(n15, { componentId: loadA.componentId, port: "a" });
    b.connect(i5, { componentId: loadA.componentId, port: "b" });
    b.connect(loadA, port(areg, "load"));
    const loadD = g("and_d", "AND");
    b.connect(i15, { componentId: loadD.componentId, port: "a" });
    b.connect(i4, { componentId: loadD.componentId, port: "b" });
    b.connect(loadD, port(dreg, "load"));
    const writeM = g("and_m", "AND");
    b.connect(i15, { componentId: writeM.componentId, port: "a" });
    b.connect(i3, { componentId: writeM.componentId, port: "b" });
    b.connect(writeM, oWriteM);
    const zrNg = g("or_zn", "OR");
    b.connect(port(alu, "zr"), { componentId: zrNg.componentId, port: "a" });
    b.connect(port(alu, "ng"), { componentId: zrNg.componentId, port: "b" });
    const notZn = g("not_zn", "NOT");
    b.connect(zrNg, { componentId: notZn.componentId, port: "a" });
    const jgt = g("and_gt", "AND");
    b.connect(i0, { componentId: jgt.componentId, port: "a" });
    b.connect(notZn, { componentId: jgt.componentId, port: "b" });
    const jlt = g("and_lt", "AND");
    b.connect(i2, { componentId: jlt.componentId, port: "a" });
    b.connect(port(alu, "ng"), { componentId: jlt.componentId, port: "b" });
    const jeq = g("and_eq", "AND");
    b.connect(i1, { componentId: jeq.componentId, port: "a" });
    b.connect(port(alu, "zr"), { componentId: jeq.componentId, port: "b" });
    const j01 = g("or_j01", "OR");
    b.connect(jlt, { componentId: j01.componentId, port: "a" });
    b.connect(jeq, { componentId: j01.componentId, port: "b" });
    const jumpAny = g("or_j", "OR");
    b.connect(j01, { componentId: jumpAny.componentId, port: "a" });
    b.connect(jgt, { componentId: jumpAny.componentId, port: "b" });
    const pcLoad = g("and_pc", "AND");
    b.connect(i15, { componentId: pcLoad.componentId, port: "a" });
    b.connect(jumpAny, { componentId: pcLoad.componentId, port: "b" });
    b.connect(pcLoad, port(pc, "load"));
    const ctrl = [
      [i11, "zx"],
      [i10, "nx"],
      [i9, "zy"],
      [i8, "ny"],
      [i7, "f"],
      [i6, "no"]
    ];
    for (const [src, dst] of ctrl) b.connect(src, port(alu, dst));
    b.connect(port(alu, "out"), oOutM);
    b.connect(port(dreg, "out"), oD);
    return b.build();
  }

  // src/hack/rom.ts
  var ROM_SIZE = 32768;
  function parseHack(text) {
    const words = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (line === "") continue;
      if (!/^[01]{16}$/.test(line)) {
        throw new Error(`parseHack\uFF1A\u7B2C ${i + 1} \u884C\u4E0D\u662F 16 \u4F4D\u4E8C\u8FDB\u5236\uFF1A"${raw.trim().slice(0, 40)}"`);
      }
      if (words.length >= ROM_SIZE) {
        throw new Error(`parseHack\uFF1A\u7A0B\u5E8F\u8D85\u8FC7 ROM \u5BB9\u91CF\uFF08${ROM_SIZE} \u5B57\uFF09`);
      }
      words.push(parseInt(line, 2));
    }
    return words;
  }

  // src/hack/computer.ts
  var HACK_IDS = {
    resetPin: "in_reset",
    kbdPin: "in_kbd",
    rom: "rom",
    ram: "ram",
    screen: "screen",
    obsPc: "obs_pc",
    obsA: "obs_a",
    obsD: "obs_d",
    obsOutM: "obs_outm",
    obsWriteM: "obs_writem",
    obsInstr: "obs_instr"
  };
  function buildComputerNetlist(ids) {
    const b = new NetlistBuilder();
    const templates = { [CPU_KIND]: buildCpuTemplate() };
    const reset = b.pinIn(HACK_IDS.resetPin, "reset");
    const kbd = b.pinIn(HACK_IDS.kbdPin, "kbd", 16);
    const cpu = b.add("cpu", CPU_KIND);
    const rom = b.add(HACK_IDS.rom, "ROM32K", { id: ids.romId });
    b.connect(port(cpu, "pc"), port(rom, "address"));
    b.connect(port(rom, "out"), port(cpu, "instr"));
    b.connect(reset, port(cpu, "reset"));
    const aOut = port(cpu, "a");
    const dec = b.add("memdec", "MEMDECODE");
    b.connect(aOut, port(dec, "a"));
    const isRAM = port(dec, "isram");
    const isScr = port(dec, "isscr");
    const kbdExact = port(dec, "kbd");
    const s14 = b.add("sa14", "SPLIT", { index: 14 });
    b.connect(aOut, port(s14, "bus"));
    const a14 = port(s14, "bit");
    const s13 = b.add("sa13", "SPLIT", { index: 13 });
    b.connect(aOut, port(s13, "bus"));
    const a13 = port(s13, "bit");
    const wm = port(cpu, "writeM");
    const loadRam = port(b.add("ldram", "AND"), "y");
    b.connect(wm, { componentId: loadRam.componentId, port: "a" });
    b.connect(isRAM, { componentId: loadRam.componentId, port: "b" });
    const loadScr = port(b.add("ldscr", "AND"), "y");
    b.connect(wm, { componentId: loadScr.componentId, port: "a" });
    b.connect(isScr, { componentId: loadScr.componentId, port: "b" });
    const outM = port(cpu, "outM");
    const ram = b.add(HACK_IDS.ram, "RAM16K", { id: ids.ramId });
    b.connect(outM, port(ram, "in"));
    b.connect(loadRam, port(ram, "load"));
    b.connect(aOut, port(ram, "address"));
    const screen2 = b.add(HACK_IDS.screen, "SCREEN", { id: ids.screenId });
    b.connect(outM, port(screen2, "in"));
    b.connect(loadScr, port(screen2, "load"));
    b.connect(aOut, port(screen2, "address"));
    const zero = port(b.add("zero16", "CONST", { value: 0 }), "y");
    const kbdMux = b.add("mux_kbd", "MUX16");
    b.connect(zero, port(kbdMux, "a"));
    b.connect(kbd, port(kbdMux, "b"));
    b.connect(kbdExact, port(kbdMux, "sel"));
    const m1 = b.add("mux_rs", "MUX16");
    b.connect(port(ram, "out"), port(m1, "a"));
    b.connect(port(screen2, "out"), port(m1, "b"));
    b.connect(a14, port(m1, "sel"));
    const memOut = b.add("mux_mem", "MUX16");
    b.connect(port(m1, "out"), port(memOut, "a"));
    b.connect(port(kbdMux, "out"), port(memOut, "b"));
    b.connect(a13, port(memOut, "sel"));
    b.connect(port(memOut, "out"), port(cpu, "inM"));
    const obs = (id, from) => {
      b.connect(from, b.pinOut(id, id.replace("obs_", "")));
    };
    obs(HACK_IDS.obsPc, port(cpu, "pc"));
    obs(HACK_IDS.obsA, aOut);
    obs(HACK_IDS.obsD, port(cpu, "d"));
    obs(HACK_IDS.obsOutM, outM);
    obs(HACK_IDS.obsWriteM, wm);
    obs(HACK_IDS.obsInstr, port(rom, "out"));
    return expand(b.build(), templates);
  }
  var HackMachine = class {
    engine;
    /** 展开后的扁平网表（画布可直接加载同一份） */
    netlist;
    rom;
    ram;
    screen;
    handleIds;
    resetRef;
    kbdRef;
    constructor(engine2, opts = {}) {
      this.engine = engine2;
      const lib = chipLibrary();
      for (const [kind, behavior] of Object.entries(lib)) {
        engine2.registerBehavior(kind, opts.behaviorWrapper ? opts.behaviorWrapper(kind, behavior) : behavior);
      }
      const ids = {
        rom: opts.handleIds?.rom ?? "hack-rom",
        ram: opts.handleIds?.ram ?? "hack-ram",
        screen: opts.handleIds?.screen ?? "hack-screen"
      };
      this.handleIds = ids;
      this.rom = adoptRom({ id: ids.rom });
      this.ram = adoptRam16K({ id: ids.ram });
      this.screen = adoptScreen({ id: ids.screen });
      adoptKeyboard({ id: "hack-kbd" });
      if (typeof opts.program === "string") opts.program = parseHack(opts.program);
      if (opts.program) {
        if (opts.program.length > ROM_SIZE) throw new Error(`\u7A0B\u5E8F\u8D85 ROM \u5BB9\u91CF\uFF08${ROM_SIZE} \u5B57\uFF09`);
        this.rom.words.fill(0);
        this.rom.words.splice(0, opts.program.length, ...opts.program);
      }
      if (opts.ramInit) {
        this.ram.mem.fill(0);
        for (const [k, v0] of Object.entries(opts.ramInit)) {
          this.ram.mem[Number(k)] = v0 & 65535;
        }
      } else {
        this.ram.mem.fill(0);
      }
      this.screen.words.fill(0);
      this.netlist = buildComputerNetlist({ romId: ids.rom, ramId: ids.ram, screenId: ids.screen });
      engine2.load(this.netlist);
      this.resetRef = { componentId: HACK_IDS.resetPin, port: "y" };
      this.kbdRef = { componentId: HACK_IDS.kbdPin, port: "y" };
    }
    /** 复位线（resetCycles 语义：置 1 期间 PC 钉在 0） */
    setReset(on) {
      this.engine.setInput(this.resetRef, on ? 1 : 0);
    }
    /** 键盘注入（0 = 抬键） */
    setKbd(keyCode) {
      this.engine.setInput(this.kbdRef, keyCode & 65535);
    }
    /** 一个完整机器周期：组合收敛 → 上升沿 → 组合收敛 */
    cycle() {
      this.engine.tick();
      this.engine.clockEdge();
      this.engine.tick();
    }
    /** 连跑 n 个周期（返回实际耗时 ms，供基准） */
    runCycles(n) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) this.cycle();
      return performance.now() - t0;
    }
    // 观测
    readPc() {
      return this.engine.read({ componentId: HACK_IDS.obsPc, port: "a" });
    }
    readA() {
      return this.engine.read({ componentId: HACK_IDS.obsA, port: "a" });
    }
    readD() {
      return this.engine.read({ componentId: HACK_IDS.obsD, port: "a" });
    }
    readOutM() {
      return this.engine.read({ componentId: HACK_IDS.obsOutM, port: "a" });
    }
    readWriteM() {
      return this.engine.read({ componentId: HACK_IDS.obsWriteM, port: "a" });
    }
    readInstr() {
      return this.engine.read({ componentId: HACK_IDS.obsInstr, port: "a" });
    }
    /** RAM 快照（finalRam 对拍用） */
    ramValue(addr) {
      return this.ram.mem[addr] ?? 0;
    }
  };

  // src/web/screenView.ts
  var ScreenView = class {
    constructor(ctx, onColor = [32, 225, 128], offColor = [10, 16, 14]) {
      this.ctx = ctx;
      this.onColor = onColor;
      this.offColor = offColor;
      this.img = ctx.createImageData(512, 256);
      this.buf = this.img.data;
    }
    img;
    buf;
    lastWords = null;
    lastSnap = new Array(8192).fill(-1);
    /** 渲染一帧（words = 8192 个屏幕字）。与上次相同则跳过重绘。 */
    render(words) {
      if (words === this.lastWords) {
        let dirty = false;
        for (let i = 0; i < 8192; i++) {
          if ((words[i] ?? 0) !== this.lastSnap[i]) {
            dirty = true;
            break;
          }
        }
        if (!dirty) return;
      }
      this.lastWords = words;
      const [or, og, ob] = this.onColor;
      const [fr, fg, fb] = this.offColor;
      for (let w = 0; w < 8192; w++) {
        const val = words[w] ?? 0;
        if (val === this.lastSnap[w]) continue;
        this.lastSnap[w] = val;
        const row = w >> 5;
        const col = w & 31;
        const base = (row * 512 + col * 16) * 4;
        for (let b = 0; b < 16; b++) {
          const on = val >>> 15 - b & 1;
          const o = base + b * 4;
          this.buf[o] = on ? or : fr;
          this.buf[o + 1] = on ? og : fg;
          this.buf[o + 2] = on ? ob : fb;
          this.buf[o + 3] = 255;
        }
      }
      this.ctx.putImageData(this.img, 0, 0);
    }
  };
  function hackKeyCode(e) {
    switch (e.key) {
      case "Backspace":
        return 8;
      case "Tab":
        return 9;
      case "Enter":
        return 13;
      case "Escape":
        return 27;
      case "ArrowLeft":
        return 37;
      case "ArrowUp":
        return 38;
      case "ArrowRight":
        return 39;
      case "ArrowDown":
        return 40;
      default: {
        if (e.key.length === 1) return e.key.codePointAt(0) ?? 0;
        return -1;
      }
    }
  }

  // src/canvas/geometry/grid.ts
  var GRID = 20;
  function snapScalar(v2, grid = GRID) {
    if (!(grid > 0) || !Number.isFinite(v2)) return v2;
    const q = v2 / grid;
    const r = Math.round(Math.abs(q)) * (q < 0 ? -1 : 1);
    const out = r * grid;
    return out === 0 ? 0 : out;
  }
  function snapPos(p3, grid = GRID) {
    return { x: snapScalar(p3.x, grid), y: snapScalar(p3.y, grid) };
  }

  // src/canvas/model/shapes.ts
  function sideToDir(side) {
    switch (side) {
      case "left":
        return "left";
      case "right":
        return "right";
      case "top":
        return "up";
      case "bottom":
        return "down";
    }
  }
  var gatePorts = [
    { name: "A", dir: "in", side: "left", ux: 0, uy: 1 },
    { name: "B", dir: "in", side: "left", ux: 0, uy: 3 },
    { name: "OUT", dir: "out", side: "right", ux: 3, uy: 2 }
  ];
  var DEFAULT_SHAPES = [
    { kind: "INPUT", label: "\u8F93\u5165", w: 2, h: 2, ports: [{ name: "OUT", dir: "out", side: "right", ux: 2, uy: 1 }] },
    { kind: "OUTPUT", label: "\u8F93\u51FA", w: 2, h: 2, ports: [{ name: "IN", dir: "in", side: "left", ux: 0, uy: 1 }] },
    { kind: "AND", label: "AND", w: 3, h: 4, ports: gatePorts },
    { kind: "OR", label: "OR", w: 3, h: 4, ports: gatePorts },
    { kind: "XOR", label: "XOR", w: 3, h: 4, ports: gatePorts },
    {
      kind: "NOT",
      label: "NOT",
      w: 3,
      h: 4,
      ports: [
        { name: "A", dir: "in", side: "left", ux: 0, uy: 2 },
        { name: "OUT", dir: "out", side: "right", ux: 3, uy: 2 }
      ]
    },
    {
      kind: "DFF",
      label: "DFF",
      w: 3,
      h: 4,
      ports: [
        { name: "D", dir: "in", side: "left", ux: 0, uy: 1 },
        { name: "CLK", dir: "in", side: "left", ux: 0, uy: 3 },
        { name: "Q", dir: "out", side: "right", ux: 3, uy: 2 }
      ]
    },
    { kind: "CLK", label: "\u65F6\u949F", w: 2, h: 4, ports: [{ name: "OUT", dir: "out", side: "right", ux: 2, uy: 2 }] }
  ];
  var registry = /* @__PURE__ */ new Map();
  for (const def of DEFAULT_SHAPES) registry.set(def.kind, def);
  function registerShape(def) {
    registry.set(def.kind, def);
  }
  function genericShape(kind) {
    return { kind, label: kind, w: 2, h: 2, ports: [] };
  }
  function getShape(kind) {
    return registry.get(kind) ?? genericShape(kind);
  }
  function listShapeKinds() {
    return [...registry.keys()];
  }
  function componentPixelSize(kind) {
    const def = getShape(kind);
    return { w: def.w * GRID, h: def.h * GRID };
  }
  function componentBoundsOf(comp) {
    const s = componentPixelSize(comp.kind);
    return { x: comp.pos.x, y: comp.pos.y, w: s.w, h: s.h };
  }
  function portPos(comp, portName) {
    const def = getShape(comp.kind);
    const p3 = def.ports.find((pt) => pt.name === portName);
    if (!p3) return null;
    return { x: comp.pos.x + p3.ux * GRID, y: comp.pos.y + p3.uy * GRID };
  }
  function portsOf(comp) {
    const def = getShape(comp.kind);
    return def.ports.map((p3) => ({
      port: p3,
      pos: { x: comp.pos.x + p3.ux * GRID, y: comp.pos.y + p3.uy * GRID }
    }));
  }
  function portStubDir(kind, portName) {
    const def = getShape(kind);
    const p3 = def.ports.find((pt) => pt.name === portName);
    return p3 ? sideToDir(p3.side) : null;
  }

  // src/web/chipShapes.ts
  function spread(count, rows, i) {
    if (count <= 1) return Math.floor(rows / 2);
    return Math.round(i * (rows - 1) / (count - 1));
  }
  function shapeFor(kind, ports) {
    const ins = ports.filter((pt) => pt.dir === "in");
    const outs = ports.filter((pt) => pt.dir === "out");
    const rows = Math.max(ins.length, outs.length, 2);
    const h = rows;
    const w = Math.min(5, Math.max(2, Math.ceil(kind.length / 3)));
    const shapePorts = [];
    ins.forEach((pt, i) => {
      shapePorts.push({ name: pt.name, dir: "in", side: "left", ux: 0, uy: spread(ins.length, rows, i) });
    });
    outs.forEach((pt, i) => {
      shapePorts.push({ name: pt.name, dir: "out", side: "right", ux: w, uy: spread(outs.length, rows, i) });
    });
    return { kind, label: kind, w, h, ports: shapePorts };
  }
  function registerChipShapes() {
    const all = {
      ...PRIMITIVES,
      ...chipLibrary()
    };
    for (const [kind, behavior] of Object.entries(all)) {
      registerShape(shapeFor(kind, behavior.ports));
    }
  }

  // src/canvas/state/edits.ts
  function nextComponentId(nl) {
    let max = 0;
    for (const c of nl.components) {
      const m = c.id.match(/^c(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `c${max + 1}`;
  }
  function nextWireId(nl) {
    let max = 0;
    for (const w of nl.wires) {
      const m = w.id.match(/^w(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `w${max + 1}`;
  }
  function addComponent(nl, kind, pos, props = {}) {
    const id = nextComponentId(nl);
    const comp = { id, kind, pos: { ...pos }, props: { ...props } };
    return { netlist: { components: [...nl.components, comp], wires: nl.wires }, id };
  }
  function moveComponents(nl, ids, delta) {
    if (delta.x === 0 && delta.y === 0) return nl;
    return {
      components: nl.components.map(
        (c) => ids.has(c.id) ? { ...c, pos: { ...c.pos, x: c.pos.x + delta.x, y: c.pos.y + delta.y } } : c
      ),
      wires: nl.wires
    };
  }
  function deleteIds(nl, componentIds, wireIds) {
    return {
      components: nl.components.filter((c) => !componentIds.has(c.id)),
      wires: nl.wires.filter(
        (w) => !wireIds.has(w.id) && !componentIds.has(w.from.componentId) && !componentIds.has(w.to.componentId)
      )
    };
  }
  function addWire(nl, from, to) {
    if (from.componentId === to.componentId && from.port === to.port) {
      return { ok: false, reason: "self" };
    }
    const dup = nl.wires.some(
      (w) => sameRef(w.from, from) && sameRef(w.to, to) || sameRef(w.from, to) && sameRef(w.to, from)
    );
    if (dup) return { ok: false, reason: "duplicate" };
    const id = nextWireId(nl);
    const wire = { id, from: { ...from }, to: { ...to } };
    return { ok: true, netlist: { components: nl.components, wires: [...nl.wires, wire] }, id };
  }
  function sameRef(a, b) {
    return a.componentId === b.componentId && a.port === b.port;
  }
  function setProps(nl, id, props) {
    return {
      components: nl.components.map((c) => c.id === id ? { ...c, props: { ...props } } : c),
      wires: nl.wires
    };
  }
  function patchProps(nl, id, patch) {
    const comp = nl.components.find((c) => c.id === id);
    if (!comp) return nl;
    return setProps(nl, id, { ...comp.props, ...patch });
  }
  function applyPreviewDelta(nl, ids, delta) {
    if (!delta || delta.x === 0 && delta.y === 0) return nl;
    return moveComponents(nl, ids, delta);
  }

  // src/canvas/state/history.ts
  var History = class {
    constructor(limit = 100) {
      this.limit = limit;
    }
    undoStack = [];
    redoStack = [];
    /** 在"应用新状态前"调用：把当前状态存入撤销栈，并作废重做栈 */
    push(current) {
      this.undoStack.push(current);
      if (this.undoStack.length > this.limit) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }
    /** 撤销：current 进重做栈，弹出并返回上一个状态（不可撤销返回 null） */
    undo(current) {
      const prev = this.undoStack.pop();
      if (prev === void 0) return null;
      this.redoStack.push(current);
      return prev;
    }
    /** 重做：current 进撤销栈，弹出并返回下一个状态（不可重做返回 null） */
    redo(current) {
      const next = this.redoStack.pop();
      if (next === void 0) return null;
      this.undoStack.push(current);
      return next;
    }
    get canUndo() {
      return this.undoStack.length > 0;
    }
    get canRedo() {
      return this.redoStack.length > 0;
    }
    /** 撤销栈深度（测试观测） */
    get depth() {
      return this.undoStack.length;
    }
    clear() {
      this.undoStack = [];
      this.redoStack = [];
    }
  };

  // src/canvas/state/selection.ts
  function makeSelection(components, wires) {
    return { components: new Set(components), wires: new Set(wires) };
  }
  function toggleInSelection(s, kind, id) {
    if (kind === "component") {
      const next2 = new Set(s.components);
      if (next2.has(id)) next2.delete(id);
      else next2.add(id);
      return { components: next2, wires: s.wires };
    }
    const next = new Set(s.wires);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { components: s.components, wires: next };
  }
  function unionSelection(a, b) {
    return {
      components: /* @__PURE__ */ new Set([...a.components, ...b.components]),
      wires: /* @__PURE__ */ new Set([...a.wires, ...b.wires])
    };
  }
  function pruneSelection(s, aliveComponents2, aliveWires2) {
    return {
      components: new Set([...s.components].filter((id) => aliveComponents2.has(id))),
      wires: new Set([...s.wires].filter((id) => aliveWires2.has(id)))
    };
  }
  function clearSelection() {
    return { components: /* @__PURE__ */ new Set(), wires: /* @__PURE__ */ new Set() };
  }

  // src/canvas/state/clipboard.ts
  var CLIPBOARD_MAGIC = "cir-canvas-clipboard-v1";
  function copySelection(nl, sel) {
    const comps = nl.components.filter((c) => sel.components.has(c.id));
    const idSet = new Set(comps.map((c) => c.id));
    const wires = nl.wires.filter((w) => idSet.has(w.from.componentId) && idSet.has(w.to.componentId));
    if (comps.length === 0) return { components: [], wires: [] };
    let minX = Infinity;
    let minY = Infinity;
    for (const c of comps) {
      if (c.pos.x < minX) minX = c.pos.x;
      if (c.pos.y < minY) minY = c.pos.y;
    }
    return {
      components: comps.map((c) => ({ ...structuredClone(c), pos: { x: c.pos.x - minX, y: c.pos.y - minY } })),
      wires: structuredClone(wires)
    };
  }
  function pasteData(data, nl, offset) {
    const idMap = /* @__PURE__ */ new Map();
    let components = [...nl.components];
    for (const c of data.components) {
      const newId = nextComponentId({ components, wires: [] });
      idMap.set(c.id, newId);
      components = [
        ...components,
        {
          id: newId,
          kind: c.kind,
          pos: { x: c.pos.x + offset.x, y: c.pos.y + offset.y },
          props: { ...c.props }
        }
      ];
    }
    const wires = [];
    for (const w of data.wires) {
      const from = idMap.get(w.from.componentId);
      const to = idMap.get(w.to.componentId);
      if (!from || !to) continue;
      wires.push({ id: nextWireId({ components, wires }), from: { componentId: from, port: w.from.port }, to: { componentId: to, port: w.to.port } });
    }
    const netlist = { components, wires: [...nl.wires, ...wires] };
    return {
      netlist,
      selection: {
        components: new Set(idMap.values()),
        wires: new Set(wires.map((w) => w.id))
      }
    };
  }
  function toClipboardText(data) {
    return JSON.stringify({ magic: CLIPBOARD_MAGIC, ...data });
  }
  function fromClipboardText(text) {
    try {
      const obj = JSON.parse(text);
      if (obj.magic !== CLIPBOARD_MAGIC) return null;
      if (!Array.isArray(obj.components) || !Array.isArray(obj.wires)) return null;
      return { components: obj.components, wires: obj.wires };
    } catch {
      return null;
    }
  }

  // src/canvas/state/doc.ts
  var NetlistDoc = class {
    netlist;
    selection = { components: /* @__PURE__ */ new Set(), wires: /* @__PURE__ */ new Set() };
    /** 连线拐点覆盖层（画布侧数据，随删除修剪） */
    bends = /* @__PURE__ */ new Map();
    /** 拖拽预览增量（渲染专用，不落历史） */
    previewDelta = null;
    /** 拐点拖拽预览 */
    bendPreview = null;
    history = new History(100);
    listeners = /* @__PURE__ */ new Set();
    constructor(netlist = { components: [], wires: [] }) {
      this.netlist = netlist;
    }
    /* ------------------------------ 订阅 ------------------------------ */
    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit() {
      for (const l of this.listeners) l();
    }
    /* ---------------------------- 历史与提交 ---------------------------- */
    /** 提交新网表（推历史） */
    commit(next) {
      this.history.push(this.netlist);
      this.netlist = next;
      this.selection = pruneSelection(this.selection, aliveComponents(next), aliveWires(next));
      this.pruneBends();
      this.emit();
    }
    undo() {
      const prev = this.history.undo(this.netlist);
      if (prev === null) return false;
      this.netlist = prev;
      this.selection = pruneSelection(this.selection, aliveComponents(prev), aliveWires(prev));
      this.pruneBends();
      this.emit();
      return true;
    }
    redo() {
      const next = this.history.redo(this.netlist);
      if (next === null) return false;
      this.netlist = next;
      this.selection = pruneSelection(this.selection, aliveComponents(next), aliveWires(next));
      this.pruneBends();
      this.emit();
      return true;
    }
    get canUndo() {
      return this.history.canUndo;
    }
    get canRedo() {
      return this.history.canRedo;
    }
    pruneBends() {
      const wireIds = new Set(this.netlist.wires.map((w) => w.id));
      for (const id of [...this.bends.keys()]) {
        if (!wireIds.has(id)) this.bends.delete(id);
      }
    }
    /* ------------------------------ 编辑 ------------------------------ */
    addComponentAt(kind, pos) {
      const { netlist, id } = addComponent(this.netlist, kind, pos);
      this.commit(netlist);
      this.selection = makeSelection([id], []);
      this.emit();
      return id;
    }
    deleteSelection() {
      if (this.selection.components.size === 0 && this.selection.wires.size === 0) return;
      this.commit(deleteIds(this.netlist, this.selection.components, this.selection.wires));
      this.selection = clearSelection();
    }
    /** 提交移动（拖拽结束） */
    commitMove(delta) {
      this.previewDelta = null;
      if (delta.x === 0 && delta.y === 0) return;
      this.commit(moveComponents(this.netlist, this.selection.components, delta));
    }
    cancelMove() {
      this.previewDelta = null;
      this.emit();
    }
    /** 开始移动预览 */
    movePreview(delta) {
      this.previewDelta = delta;
      this.emit();
    }
    /** 提交连线拐点 */
    commitBend(wireId, pos) {
      this.bendPreview = null;
      this.bends.set(wireId, pos);
      this.emit();
    }
    cancelBend() {
      this.bendPreview = null;
      this.emit();
    }
    bendPreviewAt(wireId, pos) {
      this.bendPreview = { wireId, pos };
      this.emit();
    }
    /** 布线提交；成功返回连线 id，失败返回原因 */
    addWireBetween(from, to) {
      const r = addWire(this.netlist, from, to);
      if (!r.ok) return r;
      this.commit(r.netlist);
      this.selection = makeSelection([], [r.id]);
      this.emit();
      return { ok: true, id: r.id };
    }
    setComponentProps(id, props) {
      this.commit(setProps(this.netlist, id, props));
    }
    patchComponentProps(id, patch) {
      this.commit(patchProps(this.netlist, id, patch));
    }
    setSelection(selection) {
      this.selection = selection;
      this.emit();
    }
    /* ---------------------------- 剪贴板 ---------------------------- */
    copyToText() {
      return toClipboardText(copySelection(this.netlist, this.selection));
    }
    copyData() {
      return copySelection(this.netlist, this.selection);
    }
    /** 从文本粘贴；成功返回新选中数，失败返回 -1 */
    pasteFromText(text, offset = { x: 40, y: 40 }) {
      const data = fromClipboardText(text);
      if (!data || data.components.length === 0) return -1;
      const { netlist, selection } = pasteData(data, this.netlist, offset);
      this.commit(netlist);
      this.selection = selection;
      this.emit();
      return selection.components.size;
    }
    pasteData(d, offset = { x: 40, y: 40 }) {
      if (d.components.length === 0) return -1;
      const { netlist, selection } = pasteData(d, this.netlist, offset);
      this.commit(netlist);
      this.selection = selection;
      this.emit();
      return selection.components.size;
    }
    /* ------------------------------ 查询 ------------------------------ */
    findComponent(id) {
      return this.netlist.components.find((c) => c.id === id) ?? null;
    }
  };
  function aliveComponents(nl) {
    return new Set(nl.components.map((c) => c.id));
  }
  function aliveWires(nl) {
    return new Set(nl.wires.map((w) => w.id));
  }

  // src/canvas/geometry/types.ts
  var DIR_VEC = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y)
    };
  }
  function normalizeRect(r) {
    return {
      x: r.w >= 0 ? r.x : r.x + r.w,
      y: r.h >= 0 ? r.y : r.y + r.h,
      w: Math.abs(r.w),
      h: Math.abs(r.h)
    };
  }

  // src/canvas/geometry/route.ts
  var STUB = 20;
  function stubEnd(port2, dir, stub = STUB) {
    const v2 = DIR_VEC[dir];
    return { x: port2.x + v2.x * stub, y: port2.y + v2.y * stub };
  }
  function orthoMid(s, t, grid = 20) {
    if (s.y === t.y || s.x === t.x) return [];
    if (s.x < t.x) {
      const midX = snapScalar((s.x + t.x) / 2, grid);
      return [
        { x: midX, y: s.y },
        { x: midX, y: t.y }
      ];
    }
    const midY = snapScalar((s.y + t.y) / 2, grid);
    return [
      { x: s.x, y: midY },
      { x: t.x, y: midY }
    ];
  }
  function orthoViaWaypoint(s, t, wp) {
    const w = snapPos(wp);
    return [
      { x: w.x, y: s.y },
      w,
      { x: t.x, y: w.y }
    ];
  }
  function routeOrthogonal(a, dirA, b, dirB, waypoint, grid = 20) {
    if (a.x === b.x && a.y === b.y) return [a];
    const s = stubEnd(a, dirA, STUB);
    const t = stubEnd(b, dirB, STUB);
    const mid = waypoint !== void 0 ? orthoViaWaypoint(s, t, waypoint) : orthoMid(s, t, grid);
    return simplifyPolyline([a, s, ...mid, t, b]);
  }
  function simplifyPolyline(pts) {
    const out = [];
    for (const p3 of pts) {
      const last = out[out.length - 1];
      if (last && last.x === p3.x && last.y === p3.y) continue;
      out.push(p3);
    }
    for (let i = 1; i + 1 < out.length; ) {
      const prev = out[i - 1];
      const cur = out[i];
      const next = out[i + 1];
      const horiz = prev.y === cur.y && cur.y === next.y;
      const vert = prev.x === cur.x && cur.x === next.x;
      if (horiz || vert) {
        out.splice(i, 1);
      } else {
        i++;
      }
    }
    const out2 = [];
    for (const p3 of out) {
      const last = out2[out2.length - 1];
      if (last && last.x === p3.x && last.y === p3.y) continue;
      out2.push(p3);
    }
    return out2;
  }

  // src/canvas/geometry/wirepath.ts
  function portKey2(componentId, port2) {
    return componentId + ":" + port2;
  }
  var compIndexCache = /* @__PURE__ */ new WeakMap();
  function compIndexOf(nl) {
    return compIndexCache.get(nl) ?? buildIndex(nl);
  }
  function buildIndex(nl) {
    const m = /* @__PURE__ */ new Map();
    for (const c of nl.components) m.set(c.id, c);
    compIndexCache.set(nl, m);
    return m;
  }
  var routeCache = /* @__PURE__ */ new WeakMap();
  function wirePolyline(nl, wire, bends) {
    if (bends === void 0 || bends.size === 0) {
      const cached = routeCache.get(nl)?.get(wire.id);
      if (cached) return cached;
    }
    const index = compIndexOf(nl);
    const from = index.get(wire.from.componentId);
    const on = index.get(wire.to.componentId);
    const to = on;
    let pts;
    const a = from ? portPos(from, wire.from.port) : null;
    const b = to ? portPos(to, wire.to.port) : null;
    if (!from || !to || !a || !b) {
      pts = straightFallback(from, to);
    } else {
      const dirA = portStubDir(from.kind, wire.from.port) ?? "right";
      const dirB = portStubDir(to.kind, wire.to.port) ?? "left";
      pts = routeOrthogonal(a, dirA, b, dirB, bends?.get(wire.id));
    }
    if (bends === void 0 || bends.size === 0) {
      let m = routeCache.get(nl);
      if (m === void 0) {
        m = /* @__PURE__ */ new Map();
        routeCache.set(nl, m);
      }
      m.set(wire.id, pts);
    }
    return pts;
  }
  function straightFallback(from, to) {
    if (!from || !to) return [];
    return [
      { x: from.pos.x, y: from.pos.y },
      { x: to.pos.x, y: to.pos.y }
    ];
  }
  function allWirePolylines(nl, bends) {
    if (bends === void 0 || bends.size === 0) {
      const cached = routeCache.get(nl);
      if (cached !== void 0 && cached.size >= nl.wires.length) return cached;
    }
    const map = /* @__PURE__ */ new Map();
    for (const w of nl.wires) map.set(w.id, wirePolyline(nl, w, bends));
    return map;
  }

  // src/canvas/sim/SimController.ts
  var RUN_BASE_HZ = 60;
  var SimController = class {
    constructor(engine2) {
      this.engine = engine2;
    }
    values = /* @__PURE__ */ new Map();
    lastTick = null;
    running = false;
    timer = null;
    speed = 1;
    listeners = /* @__PURE__ */ new Set();
    /** 诊断缓存（值刷新时同步更新，渲染每帧读缓存而非重算引擎） */
    diagCache = [];
    netlistRef = { components: [], wires: [] };
    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    emit() {
      for (const l of this.listeners) l();
    }
    /** 网表变更后同步引擎（重新 load） */
    syncNetlist(nl) {
      this.netlistRef = nl;
      this.engine.load(nl);
      this.refreshValues();
    }
    /** 刷新全端口值表与诊断缓存（渲染用） */
    refreshValues() {
      const map = /* @__PURE__ */ new Map();
      for (const comp of this.netlistRef.components) {
        for (const p3 of getShape(comp.kind).ports) {
          map.set(portKey2(comp.id, p3.name), this.engine.read({ componentId: comp.id, port: p3.name }));
        }
      }
      this.values = map;
      this.diagCache = this.engine.diagnostics();
      this.emit();
    }
    /** 注入网表引用（渲染侧值表来源；也可由 syncNetlist 隐式调用） */
    setNetlistRef(nl) {
      this.netlistRef = nl;
    }
    tick(maxSteps) {
      this.lastTick = this.engine.tick(maxSteps);
      this.refreshValues();
      return this.lastTick;
    }
    clockEdge() {
      this.engine.clockEdge();
      this.refreshValues();
    }
    reset() {
      this.engine.reset();
      this.refreshValues();
    }
    setInput(port2, value) {
      this.engine.setInput(port2, value);
      this.refreshValues();
    }
    /** 翻转 INPUT 组件（返回翻转后的值） */
    toggleInput(componentId) {
      const cur = this.engine.read({ componentId, port: "OUT" });
      const next = cur === 1 ? 0 : 1;
      this.engine.setInput({ componentId, port: "OUT" }, next);
      this.refreshValues();
      return next;
    }
    /* ------------------------------ run 循环 ------------------------------ */
    /** 单次运行迭代：组合传播 + 时钟沿（60Hz 每帧调用一次） */
    step() {
      this.tick();
      this.clockEdge();
    }
    run() {
      if (this.running) return;
      this.running = true;
      const interval = Math.max(4, Math.round(1e3 / (RUN_BASE_HZ * this.speed)));
      this.timer = setInterval(() => this.step(), interval);
      this.emit();
    }
    pause() {
      if (!this.running) return;
      this.running = false;
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.emit();
    }
    setSpeed(s) {
      this.speed = s;
      if (this.running) {
        this.pause();
        this.run();
      }
      this.emit();
    }
    getSpeed() {
      return this.speed;
    }
    diagnostics() {
      return this.diagCache;
    }
    dispose() {
      this.pause();
      this.listeners.clear();
    }
  };

  // src/canvas/geometry/view.ts
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 5;
  function clampZoom(z, min = ZOOM_MIN, max = ZOOM_MAX) {
    if (Number.isNaN(z)) return min;
    return Math.min(max, Math.max(min, z));
  }
  function panForZoomAt(anchor, world, newZoom) {
    return { x: anchor.x - world.x * newZoom, y: anchor.y - world.y * newZoom };
  }
  function worldToScreen(p3, pan, zoom) {
    return { x: p3.x * zoom + pan.x, y: p3.y * zoom + pan.y };
  }
  function screenToWorld(p3, pan, zoom) {
    return { x: (p3.x - pan.x) / zoom, y: (p3.y - pan.y) / zoom };
  }

  // src/canvas/ui/CanvasView.ts
  var CanvasView = class {
    canvas;
    ctx = null;
    cbs = null;
    width = 800;
    height = 600;
    pan = { x: 60, y: 40 };
    zoom = 1;
    panning = false;
    panLast = { x: 0, y: 0 };
    constructor(canvas) {
      this.canvas = canvas;
    }
    /** 绑定回调并初始化事件（构造后调用一次） */
    attach(cbs) {
      if (this.ctx) return;
      const ctx = this.canvas.getContext("2d");
      if (!ctx) throw new Error("\u65E0\u6CD5\u83B7\u53D6 2D context");
      this.ctx = ctx;
      this.cbs = cbs;
      this.bindEvents();
      this.resize();
    }
    /** DPR 适配：物理像素 = CSS 像素 × dpr，绘制坐标系仍为 CSS 像素 */
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, Math.round(rect.width));
      this.height = Math.max(1, Math.round(rect.height));
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.cbs) this.cbs.onResize(this.width, this.height);
    }
    /** 供渲染取 2D context 的原生句柄（Controller 用 CanvasAdapter 包装） */
    get rawContext() {
      if (!this.ctx) throw new Error("CanvasView \u672A attach");
      return this.ctx;
    }
    screenToWorld(p3) {
      return screenToWorld(p3, this.pan, this.zoom);
    }
    worldToScreen(p3) {
      const z = this.zoom;
      return { x: p3.x * z + this.pan.x, y: p3.y * z + this.pan.y };
    }
    /** 以屏幕点为锚缩放（锚点世界坐标保持不动） */
    zoomAt(screenPos, factor) {
      const newZoom = clampZoom(this.zoom * factor);
      const world = this.screenToWorld(screenPos);
      this.zoom = newZoom;
      this.pan = panForZoomAt(screenPos, world, newZoom);
      if (this.cbs) this.cbs.onViewChanged();
    }
    setZoomAtCenter(zoom) {
      const center = { x: this.width / 2, y: this.height / 2 };
      const newZoom = clampZoom(zoom);
      const world = this.screenToWorld(center);
      this.zoom = newZoom;
      this.pan = panForZoomAt(center, world, newZoom);
      if (this.cbs) this.cbs.onViewChanged();
    }
    toInfo(e) {
      const rect = this.canvas.getBoundingClientRect();
      const screen2 = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      return {
        screen: screen2,
        world: this.screenToWorld(screen2),
        button: e.button,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey
      };
    }
    bindEvents() {
      const cbs = () => {
        if (!this.cbs) throw new Error("CanvasView \u672A attach");
        return this.cbs;
      };
      const c = this.canvas;
      c.addEventListener("mousedown", (e) => {
        if (e.button === 1 || e.button === 0 && cbs().isPanMode()) {
          this.panning = true;
          this.panLast = { x: e.clientX, y: e.clientY };
          e.preventDefault();
          return;
        }
        cbs().onPointerDown(this.toInfo(e));
      });
      c.addEventListener("mousemove", (e) => {
        if (this.panning) {
          this.pan = {
            x: this.pan.x + (e.clientX - this.panLast.x),
            y: this.pan.y + (e.clientY - this.panLast.y)
          };
          this.panLast = { x: e.clientX, y: e.clientY };
          cbs().onViewChanged();
          return;
        }
        cbs().onPointerMove(this.toInfo(e));
      });
      window.addEventListener("mouseup", (e) => {
        if (this.panning) {
          this.panning = false;
          return;
        }
        cbs().onPointerUp(this.toInfo(e));
      });
      c.addEventListener("dblclick", (e) => {
        e.preventDefault();
        cbs().onDoubleClick(this.toInfo(e));
      });
      c.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = this.canvas.getBoundingClientRect();
          const screen2 = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
          cbs().onWheel(factor, screen2);
        },
        { passive: false }
      );
      c.addEventListener("contextmenu", (e) => {
        e.preventDefault();
      });
      window.addEventListener("resize", () => this.resize());
    }
  };

  // src/canvas/render/CanvasAdapter.ts
  var CanvasAdapter = class {
    constructor(ctx) {
      this.ctx = ctx;
    }
    beginPath() {
      this.ctx.beginPath();
    }
    moveTo(x, y) {
      this.ctx.moveTo(x, y);
    }
    lineTo(x, y) {
      this.ctx.lineTo(x, y);
    }
    closePath() {
      this.ctx.closePath();
    }
    arc(x, y, radius, startAngle, endAngle, counterclockwise) {
      this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise ?? false);
    }
    stroke() {
      this.ctx.stroke();
    }
    fill() {
      this.ctx.fill();
    }
    fillRect(x, y, w, h) {
      this.ctx.fillRect(x, y, w, h);
    }
    strokeRect(x, y, w, h) {
      this.ctx.strokeRect(x, y, w, h);
    }
    clearRect(x, y, w, h) {
      this.ctx.clearRect(x, y, w, h);
    }
    fillText(text, x, y) {
      this.ctx.fillText(text, x, y);
    }
    measureText(text) {
      return this.ctx.measureText(text);
    }
    setStrokeStyle(style) {
      this.ctx.strokeStyle = style;
    }
    setFillStyle(style) {
      this.ctx.fillStyle = style;
    }
    setLineWidth(width) {
      this.ctx.lineWidth = width;
    }
    setFont(font) {
      this.ctx.font = font;
    }
    setLineDash(dash) {
      this.ctx.setLineDash([...dash]);
    }
  };

  // src/canvas/render/colors.ts
  function valueColor(v2) {
    if (v2 === 1) return "#388e3c";
    if (v2 === 0) return "#173d1f";
    return "#9e9e9e";
  }
  var COLORS = {
    background: "#fafafa",
    gridMinor: "rgba(0,0,0,0.06)",
    gridMajor: "rgba(0,0,0,0.14)",
    wireSelected: "#0288d1",
    body: "#ffffff",
    bodyStroke: "#37474f",
    bodyStrokeSelected: "#0288d1",
    label: "#37474f",
    portIn: "#1565c0",
    portOut: "#ef6c00",
    selectionBox: "rgba(2,136,209,0.9)",
    selectionFill: "rgba(2,136,209,0.06)",
    marqueeStroke: "rgba(2,136,209,0.9)",
    marqueeFill: "rgba(2,136,209,0.08)",
    ghostAlpha: 0.45,
    conflict: "#d32f2f",
    floating: "#9e9e9e",
    oscillation: "#f57c00",
    diagErrorFill: "rgba(211,47,47,0.18)",
    diagWarnFill: "rgba(245,124,0,0.14)"
  };

  // src/canvas/render/shapesDraw.ts
  function paintGeneric(rc, x, y, w, h, comp) {
    rc.setFillStyle(COLORS.body);
    rc.fillRect(x, y, w, h);
    rc.setStrokeStyle(COLORS.bodyStroke);
    rc.setLineWidth(1.5);
    rc.setLineDash([4, 3]);
    rc.strokeRect(x, y, w, h);
    rc.setLineDash([]);
    rc.setFillStyle(COLORS.label);
    rc.setFont("10px sans-serif");
    rc.fillText(getShape(comp.kind).label, x + 6, y + h / 2 + 3);
  }
  function paintRectGate(label, innerArc) {
    return (rc, x, y, w, h) => {
      rc.setFillStyle(COLORS.body);
      rc.fillRect(x, y, w, h);
      rc.beginPath();
      rc.moveTo(x, y);
      rc.lineTo(x + w - h / 2, y);
      rc.arc(x + w - h / 2, y + h / 2, h / 2, -Math.PI / 2, Math.PI / 2, false);
      rc.lineTo(x, y + h);
      rc.closePath();
      rc.setStrokeStyle(COLORS.bodyStroke);
      rc.setLineWidth(1.5);
      rc.stroke();
      rc.setFillStyle(COLORS.label);
      rc.setFont("10px sans-serif");
      rc.fillText(label, x + 6, y + h / 2 + 3);
      if (innerArc) {
        rc.beginPath();
        rc.moveTo(x + 4, y);
        rc.lineTo(x + 4, y + h);
        rc.setStrokeStyle("rgba(55,71,79,0.35)");
        rc.setLineWidth(1);
        rc.stroke();
      }
    };
  }
  function paintNot(rc, x, y, w, h) {
    rc.setFillStyle(COLORS.body);
    rc.beginPath();
    rc.moveTo(x, y);
    rc.lineTo(x + w, y + h / 2);
    rc.lineTo(x, y + h);
    rc.closePath();
    rc.fill();
    rc.setStrokeStyle(COLORS.bodyStroke);
    rc.setLineWidth(1.5);
    rc.stroke();
    rc.beginPath();
    rc.arc(x + w + 4, y + h / 2, 4, 0, Math.PI * 2, false);
    rc.stroke();
    rc.setFillStyle(COLORS.label);
    rc.setFont("10px sans-serif");
    rc.fillText("1", x + 6, y + h / 2 + 3);
  }
  function paintInput(rc, x, y, w, h, comp) {
    rc.setFillStyle("#e8f5e9");
    rc.fillRect(x, y, w, h);
    rc.setStrokeStyle(COLORS.bodyStroke);
    rc.setLineWidth(1.5);
    rc.strokeRect(x, y, w, h);
    rc.setFillStyle(COLORS.label);
    rc.setFont("10px sans-serif");
    rc.fillText(getShape(comp.kind).label, x + 4, y + h / 2 + 3);
  }
  function paintClk(rc, x, y, w, h) {
    rc.setFillStyle("#fff8e1");
    rc.fillRect(x, y, w, h);
    rc.setStrokeStyle(COLORS.bodyStroke);
    rc.setLineWidth(1.5);
    rc.strokeRect(x, y, w, h);
    rc.beginPath();
    rc.moveTo(x + 4, y + h - 6);
    rc.lineTo(x + 4, y + 6);
    rc.lineTo(x + w / 2, y + 6);
    rc.lineTo(x + w / 2, y + h - 6);
    rc.lineTo(x + w - 4, y + h - 6);
    rc.setStrokeStyle(COLORS.bodyStroke);
    rc.setLineWidth(1.2);
    rc.stroke();
    rc.setFillStyle(COLORS.label);
    rc.setFont("9px sans-serif");
    rc.fillText("CLK", x + 4, y + h + 10);
  }
  var painters = /* @__PURE__ */ new Map([
    ["AND", paintRectGate("AND", false)],
    ["OR", paintRectGate("OR", true)],
    ["XOR", paintRectGate("XOR", true)]
  ]);
  function drawComponentBodyAt(rc, comp, x, y, w, h) {
    if (comp.kind === "INPUT") return paintInput(rc, x, y, w, h, comp);
    if (comp.kind === "OUTPUT") return paintInput(rc, x, y, w, h, comp);
    if (comp.kind === "NOT") return paintNot(rc, x, y, w, h);
    if (comp.kind === "CLK") return paintClk(rc, x, y, w, h);
    if (comp.kind === "DFF") {
      paintRectGate("DFF", false)(rc, x, y, w, h, comp);
      return;
    }
    const painter = painters.get(comp.kind);
    if (painter) {
      painter(rc, x, y, w, h, comp);
      return;
    }
    paintGeneric(rc, x, y, w, h, comp);
  }

  // src/canvas/render/renderer.ts
  function w2s(p3, scene) {
    return worldToScreen(p3, scene.view.pan, scene.view.zoom);
  }
  function drawGrid(rc, scene) {
    const { width, height, pan, zoom } = scene.view;
    rc.setFillStyle(COLORS.background);
    rc.fillRect(0, 0, width, height);
    const minorPx = GRID * zoom;
    const topLeft = { x: -pan.x / zoom, y: -pan.y / zoom };
    const x0 = Math.floor(topLeft.x / GRID) * GRID;
    const y0 = Math.floor(topLeft.y / GRID) * GRID;
    if (minorPx >= 8) {
      rc.setStrokeStyle(COLORS.gridMinor);
      rc.setLineWidth(1);
      rc.beginPath();
      for (let x = x0; (x - topLeft.x) * zoom <= width; x += GRID) {
        const sx = Math.round((x - topLeft.x) * zoom) + 0.5;
        rc.moveTo(sx, 0);
        rc.lineTo(sx, height);
      }
      for (let y = y0; (y - topLeft.y) * zoom <= height; y += GRID) {
        const sy = Math.round((y - topLeft.y) * zoom) + 0.5;
        rc.moveTo(0, sy);
        rc.lineTo(width, sy);
      }
      rc.stroke();
    }
    const majorPx = minorPx * 5;
    if (majorPx >= 12) {
      rc.setStrokeStyle(COLORS.gridMajor);
      rc.setLineWidth(1);
      rc.beginPath();
      for (let x = Math.floor(topLeft.x / (GRID * 5)) * GRID * 5; (x - topLeft.x) * zoom <= width; x += GRID * 5) {
        const sx = Math.round((x - topLeft.x) * zoom) + 0.5;
        rc.moveTo(sx, 0);
        rc.lineTo(sx, height);
      }
      for (let y = Math.floor(topLeft.y / (GRID * 5)) * GRID * 5; (y - topLeft.y) * zoom <= height; y += GRID * 5) {
        const sy = Math.round((y - topLeft.y) * zoom) + 0.5;
        rc.moveTo(0, sy);
        rc.lineTo(width, sy);
      }
      rc.stroke();
    }
  }
  function drawWires(rc, scene) {
    const polylines = allWirePolylines(scene.netlist, scene.bends);
    rc.setLineWidth(2);
    for (const wire of scene.netlist.wires) {
      const pts = polylines.get(wire.id) ?? [];
      if (pts.length < 2) continue;
      const selected = scene.selection.wires.has(wire.id);
      let color = COLORS.bodyStroke;
      if (scene.diags.conflictWireIds.has(wire.id)) color = COLORS.conflict;
      else if (scene.diags.floatingWireIds.has(wire.id)) color = COLORS.floating;
      else {
        const v2 = scene.values.get(portKey2(wire.from.componentId, wire.from.port));
        if (v2 !== void 0) color = valueColor(v2);
      }
      if (selected) color = COLORS.wireSelected;
      rc.setStrokeStyle(color);
      rc.beginPath();
      const first = w2s(pts[0], scene);
      rc.moveTo(first.x, first.y);
      for (let i = 1; i < pts.length; i++) {
        const s = w2s(pts[i], scene);
        rc.lineTo(s.x, s.y);
      }
      rc.stroke();
      if (pts.length > 2) {
        rc.setFillStyle(color);
        for (let i = 1; i + 1 < pts.length; i++) {
          const s = w2s(pts[i], scene);
          rc.fillRect(s.x - 2, s.y - 2, 4, 4);
        }
      }
    }
  }
  function drawComponents(rc, scene) {
    const z = scene.view.zoom;
    for (const comp of scene.netlist.components) {
      const b = componentBoundsOf(comp);
      const a = w2s({ x: b.x, y: b.y }, scene);
      drawComponentBodyAt(rc, comp, a.x, a.y, b.w * z, b.h * z);
      if (scene.selection.components.has(comp.id)) {
        rc.setStrokeStyle(COLORS.selectionBox);
        rc.setLineWidth(1.5);
        rc.strokeRect(a.x - 3, a.y - 3, b.w * z + 6, b.h * z + 6);
      }
    }
    drawPorts(rc, scene);
  }
  function drawPorts(rc, scene) {
    const r = 3;
    for (const comp of scene.netlist.components) {
      const def = getShape(comp.kind);
      for (const p3 of def.ports) {
        const world = portPos(comp, p3.name);
        if (!world) continue;
        const s = w2s(world, scene);
        rc.beginPath();
        rc.arc(s.x, s.y, r, 0, Math.PI * 2, false);
        rc.setFillStyle(p3.dir === "in" ? COLORS.portIn : COLORS.portOut);
        rc.fill();
        if (p3.dir === "out") {
          const v2 = scene.values.get(portKey2(comp.id, p3.name));
          if (v2 !== void 0) {
            rc.beginPath();
            rc.arc(s.x, s.y, 1.6, 0, Math.PI * 2, false);
            rc.setFillStyle(valueColor(v2));
            rc.fill();
          }
        }
      }
    }
  }
  function drawDiagnostics(rc, scene) {
    const z = scene.view.zoom;
    const blinkOn = Math.floor(scene.time / 420) % 2 === 1;
    for (const comp of scene.netlist.components) {
      let isError = scene.diags.errorComponentIds.has(comp.id);
      let isWarn = scene.diags.warnComponentIds.has(comp.id);
      if (!isError && !isWarn && scene.diags.oscillating && (comp.kind === "DFF" || comp.kind === "CLK")) {
        isWarn = true;
      }
      if (!isError && !isWarn) continue;
      if (isWarn && scene.diags.oscillating && !blinkOn) continue;
      const b = componentBoundsOf(comp);
      const a = w2s(b, scene);
      rc.setFillStyle(isError ? COLORS.diagErrorFill : COLORS.diagWarnFill);
      rc.fillRect(a.x, a.y, b.w * z, b.h * z);
    }
  }
  function drawOverlay(rc, scene) {
    const o = scene.overlay;
    if (o.marquee) {
      const n = normalizeRect(o.marquee);
      const a = w2s({ x: n.x, y: n.y }, scene);
      const z = scene.view.zoom;
      rc.setFillStyle(COLORS.marqueeFill);
      rc.fillRect(a.x, a.y, n.w * z, n.h * z);
      rc.setStrokeStyle(COLORS.marqueeStroke);
      rc.setLineWidth(1);
      rc.setLineDash([4, 3]);
      rc.strokeRect(a.x, a.y, n.w * z, n.h * z);
      rc.setLineDash([]);
    }
    if (o.wirePreview && o.wirePreview.length >= 2) {
      rc.setStrokeStyle(COLORS.wireSelected);
      rc.setLineWidth(2);
      rc.setLineDash([6, 4]);
      rc.beginPath();
      const first = w2s(o.wirePreview[0], scene);
      rc.moveTo(first.x, first.y);
      for (let i = 1; i < o.wirePreview.length; i++) {
        const s = w2s(o.wirePreview[i], scene);
        rc.lineTo(s.x, s.y);
      }
      rc.stroke();
      rc.setLineDash([]);
    }
    if (o.ghost) {
      const fake = { id: "__ghost__", kind: o.ghost.kind, pos: o.ghost.pos, props: {} };
      rc.setFillStyle(`rgba(255,255,255,${COLORS.ghostAlpha})`);
      const b = componentBoundsOf(fake);
      const a = w2s(b, scene);
      const z = scene.view.zoom;
      rc.fillRect(a.x, a.y, b.w * z, b.h * z);
      rc.setStrokeStyle(COLORS.bodyStroke);
      rc.setLineWidth(1);
      rc.setLineDash([4, 3]);
      rc.strokeRect(a.x, a.y, b.w * z, b.h * z);
      rc.setLineDash([]);
    }
    if (o.hoverPort) {
      const s = w2s(o.hoverPort, scene);
      rc.beginPath();
      rc.arc(s.x, s.y, 6, 0, Math.PI * 2, false);
      rc.setStrokeStyle(COLORS.wireSelected);
      rc.setLineWidth(1.5);
      rc.stroke();
    }
  }
  function drawScene(rc, scene) {
    drawGrid(rc, scene);
    drawWires(rc, scene);
    drawComponents(rc, scene);
    drawDiagnostics(rc, scene);
    drawOverlay(rc, scene);
  }

  // src/canvas/render/scene.ts
  function projectDiagnostics(diags) {
    const floatingWireIds = /* @__PURE__ */ new Set();
    const conflictWireIds = /* @__PURE__ */ new Set();
    const errorComponentIds = /* @__PURE__ */ new Set();
    const warnComponentIds = /* @__PURE__ */ new Set();
    let oscillating = false;
    for (const d of diags) {
      const target = d.level === "error" ? errorComponentIds : warnComponentIds;
      if (d.kind === "floating") {
        for (const id of d.wireIds ?? []) floatingWireIds.add(id);
        for (const id of d.componentIds ?? []) target.add(id);
      } else if (d.kind === "conflict") {
        for (const id of d.wireIds ?? []) conflictWireIds.add(id);
      } else if (d.kind === "oscillation") {
        oscillating = true;
      }
      for (const id of d.componentIds ?? []) target.add(id);
    }
    return { floatingWireIds, conflictWireIds, errorComponentIds, warnComponentIds, oscillating };
  }

  // src/canvas/interact/fsm.ts
  var DRAG_THRESHOLD = 3;
  function initialFsmState() {
    return { name: "idle" };
  }
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function snapDelta(start, pos) {
    const s = snapPos(start);
    const p3 = snapPos(pos);
    return { x: p3.x - s.x, y: p3.y - s.y };
  }
  function transition(state, event, q) {
    switch (state.name) {
      case "idle":
        return fromIdle(state, event, q);
      case "placing":
        return fromPlacing(state, event, q);
      case "dragging":
        return fromDragging(state, event, q);
      case "wiring":
        return fromWiring(state, event, q);
      case "marquee":
        return fromMarquee(state, event, q);
    }
  }
  function fromIdle(state, event, q) {
    switch (event.type) {
      case "setTool": {
        if (event.kind === null) return { state, actions: [] };
        return { state: { name: "placing", kind: event.kind, ghost: { x: 0, y: 0 } }, actions: [] };
      }
      case "mousedown": {
        if (event.button === 1) return { state, actions: [] };
        if (event.button === 2) {
          return { state, actions: [{ type: "select", selection: clearSelection() }] };
        }
        const port2 = q.portAt(event.pos);
        if (port2) {
          return {
            state: { name: "wiring", from: { componentId: port2.componentId, port: port2.port }, cursor: event.pos },
            actions: [{ type: "hover", pos: port2.pos }]
          };
        }
        const comp = q.componentAt(event.pos);
        if (comp) {
          const actions2 = [];
          let selection = q.selection;
          if (event.shift) {
            selection = toggleInSelection(selection, "component", comp.id);
            actions2.push({ type: "select", selection });
          } else if (!selection.components.has(comp.id)) {
            selection = makeSelection([comp.id], []);
            actions2.push({ type: "select", selection });
          }
          actions2.push({ type: "beginDrag" });
          return {
            state: {
              name: "dragging",
              target: "selection",
              clicked: { kind: "component", id: comp.id },
              start: event.pos,
              last: event.pos,
              moved: false
            },
            actions: actions2
          };
        }
        const wire = q.wireAt(event.pos);
        if (wire) {
          const actions2 = [];
          let selection = q.selection;
          if (event.shift) {
            selection = toggleInSelection(selection, "wire", wire.id);
            actions2.push({ type: "select", selection });
          } else if (!selection.wires.has(wire.id)) {
            selection = makeSelection([], [wire.id]);
            actions2.push({ type: "select", selection });
          }
          actions2.push({ type: "beginDrag" });
          return {
            state: {
              name: "dragging",
              target: "wire",
              clicked: { kind: "wire", id: wire.id },
              start: event.pos,
              last: event.pos,
              moved: false
            },
            actions: actions2
          };
        }
        const actions = event.shift ? [] : [{ type: "select", selection: clearSelection() }];
        return {
          state: { name: "marquee", start: event.pos, current: event.pos, additive: event.shift },
          actions
        };
      }
      case "mousemove": {
        const port2 = q.portAt(event.pos);
        return { state, actions: [{ type: "hover", pos: port2 ? port2.pos : null }] };
      }
      case "mouseup":
        return { state, actions: [] };
      case "dblclick": {
        const comp = q.componentAt(event.pos);
        if (comp) return { state, actions: [{ type: "click", kind: "component", id: comp.id }] };
        const wire = q.wireAt(event.pos);
        if (wire) return { state, actions: [{ type: "click", kind: "wire", id: wire.id }] };
        return { state, actions: [] };
      }
      case "cancel":
        return { state, actions: [{ type: "select", selection: clearSelection() }] };
    }
  }
  function fromPlacing(state, event, _q) {
    switch (event.type) {
      case "setTool": {
        if (event.kind === null) return { state: { name: "idle" }, actions: [] };
        return { state: { ...state, kind: event.kind }, actions: [] };
      }
      case "mousemove":
        return { state: { ...state, ghost: snapPos(event.pos) }, actions: [] };
      case "mousedown": {
        if (event.button === 1) return { state, actions: [] };
        if (event.button === 2) return { state: { name: "idle" }, actions: [] };
        return {
          state,
          // 保持 placing，可连续放置
          actions: [{ type: "place", kind: state.kind, pos: snapPos(state.ghost) }]
        };
      }
      case "mouseup":
      case "dblclick":
        return { state, actions: [] };
      case "cancel":
        return { state: { name: "idle" }, actions: [] };
    }
  }
  function fromDragging(state, event, _q) {
    switch (event.type) {
      case "mousemove": {
        const moved = state.moved || dist(state.start, event.pos) > DRAG_THRESHOLD;
        const next = { ...state, last: event.pos, moved };
        if (!moved) return { state: next, actions: [] };
        if (state.target === "selection") {
          return { state: next, actions: [{ type: "movePreview", delta: snapDelta(state.start, event.pos) }] };
        }
        return { state: next, actions: [{ type: "bendPreview", pos: snapPos(event.pos) }] };
      }
      case "mouseup": {
        if (event.button === 2) {
          return finishDrag(state, false);
        }
        if (event.button === 1) return { state, actions: [] };
        return finishDrag(state, true);
      }
      case "cancel":
        return finishDrag(state, false);
      case "setTool":
      case "mousedown":
      case "dblclick":
        return { state, actions: [] };
    }
  }
  function finishDrag(state, commit) {
    const actions = [];
    if (!state.moved) {
      if (state.clicked && commit) actions.push({ type: "click", ...state.clicked });
      return { state: { name: "idle" }, actions };
    }
    if (!commit) {
      actions.push(state.target === "selection" ? { type: "cancelMove" } : { type: "cancelBend" });
      return { state: { name: "idle" }, actions };
    }
    if (state.target === "selection") {
      actions.push({ type: "commitMove", delta: snapDelta(state.start, state.last) });
    } else {
      actions.push({ type: "commitBend", pos: snapPos(state.last) });
    }
    return { state: { name: "idle" }, actions };
  }
  function fromWiring(state, event, q) {
    switch (event.type) {
      case "mousemove": {
        const port2 = q.portAt(event.pos);
        return { state: { ...state, cursor: event.pos }, actions: [{ type: "hover", pos: port2 ? port2.pos : null }] };
      }
      case "mousedown": {
        if (event.button === 1) return { state, actions: [] };
        if (event.button === 2) return { state: { name: "idle" }, actions: [] };
        const port2 = q.portAt(event.pos);
        if (!port2) return { state: { name: "idle" }, actions: [] };
        if (port2.componentId === state.from.componentId && port2.port === state.from.port) {
          return {
            state,
            actions: [{ type: "status", message: "\u5E03\u7EBF\u53D6\u6D88\uFF1A\u4E0D\u80FD\u8FDE\u63A5\u5230\u540C\u4E00\u7AEF\u53E3" }]
          };
        }
        return {
          state: { name: "idle" },
          actions: [
            { type: "commitWire", from: state.from, to: { componentId: port2.componentId, port: port2.port } }
          ]
        };
      }
      case "mouseup":
      case "dblclick":
      case "setTool":
        return { state, actions: [] };
      case "cancel":
        return { state: { name: "idle" }, actions: [] };
    }
  }
  function fromMarquee(state, event, _q) {
    switch (event.type) {
      case "mousemove":
        return { state: { ...state, current: event.pos }, actions: [] };
      case "mouseup": {
        if (event.button === 1) return { state, actions: [] };
        if (event.button === 2) return { state: { name: "idle" }, actions: [] };
        return {
          state: { name: "idle" },
          actions: [
            { type: "commitMarquee", rect: rectFromPoints(state.start, state.current), additive: state.additive }
          ]
        };
      }
      case "cancel":
        return { state: { name: "idle" }, actions: [] };
      case "setTool":
      case "mousedown":
      case "dblclick":
        return { state, actions: [] };
    }
  }

  // src/canvas/geometry/hit.ts
  function pointInRect(p3, r) {
    const n = normalizeRect(r);
    return p3.x >= n.x && p3.x <= n.x + n.w && p3.y >= n.y && p3.y <= n.y + n.h;
  }
  function rectsIntersect(a, b) {
    const na = normalizeRect(a);
    const nb = normalizeRect(b);
    return na.x <= nb.x + nb.w && na.x + na.w >= nb.x && na.y <= nb.y + nb.h && na.y + na.h >= nb.y;
  }
  function polylineBounds(pts) {
    if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = pts[0].x;
    let maxX = minX;
    let minY = pts[0].y;
    let maxY = minY;
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    return rectFromPoints({ x: minX, y: minY }, { x: maxX, y: maxY });
  }

  // src/canvas/io/serialize.ts
  function serializeNetlist(nl) {
    return JSON.stringify({
      format: "cir-canvas-netlist",
      version: 1,
      components: nl.components.map((c) => ({ id: c.id, kind: c.kind, pos: { x: c.pos.x, y: c.pos.y }, props: c.props })),
      wires: nl.wires.map((w) => ({
        id: w.id,
        from: { componentId: w.from.componentId, port: w.from.port },
        to: { componentId: w.to.componentId, port: w.to.port }
      }))
    });
  }

  // src/canvas/io/fileio.ts
  var LS_KEY = "cir-canvas.autosave";
  var browserStorage = {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v2) => localStorage.setItem(k, v2),
    removeItem: (k) => localStorage.removeItem(k)
  };
  function saveLocal(nl, storage = browserStorage) {
    try {
      storage.setItem(LS_KEY, serializeNetlist(nl));
      return true;
    } catch {
      return false;
    }
  }

  // src/canvas/ui/Controller.ts
  var SELECT_TOOL = "__select__";
  var Controller = class {
    doc;
    sim;
    view;
    hooks;
    fsm = initialFsmState();
    hoverPort = null;
    dirty = true;
    rafId = null;
    spaceHeld = false;
    lastCopyText = "";
    saveTimer = null;
    disposed = false;
    constructor(doc, sim, view, hooks) {
      this.doc = doc;
      this.sim = sim;
      this.view = view;
      this.hooks = hooks;
      this.bindKeyboard();
      this.bindCanvasView();
      doc.onChange(() => {
        this.syncEngine();
        this.scheduleSave();
        this.invalidate();
        this.hooks.onSelectionChanged();
      });
      sim.onChange(() => {
        this.invalidate();
        this.hooks.onSimEvent();
      });
      this.syncEngine();
      const loop = () => {
        if (this.disposed) return;
        if (this.dirty || this.oscillating()) {
          this.render();
          this.dirty = false;
        }
        this.rafId = requestAnimationFrame(loop);
      };
      this.rafId = requestAnimationFrame(loop);
    }
    dispose() {
      this.disposed = true;
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.sim.dispose();
    }
    /* ------------------------------ FSM 查询实现 ------------------------------ */
    get selection() {
      return this.doc.selection;
    }
    portAt(pos) {
      for (const comp of this.doc.netlist.components) {
        for (const entry of portsOf(comp)) {
          if (Math.hypot(entry.pos.x - pos.x, entry.pos.y - pos.y) <= 6) {
            return { componentId: comp.id, port: entry.port.name, pos: entry.pos };
          }
        }
      }
      return null;
    }
    componentAt(pos) {
      for (const comp of this.doc.netlist.components) {
        if (pointInRect(pos, componentBoundsOf(comp))) return comp;
      }
      return null;
    }
    wireAt(pos) {
      for (const w of this.doc.netlist.wires) {
        const pts = wirePolyline(this.doc.netlist, w, this.doc.bends);
        if (pts.length >= 2 && distToPolyline(pos, pts) <= 5) return w;
      }
      return null;
    }
    /* ------------------------------ 事件入口 ------------------------------ */
    onPointerDown(e) {
      this.dispatch({
        type: "mousedown",
        pos: snapPos(e.world),
        button: e.button,
        shift: e.shift
      });
    }
    onPointerMove(e) {
      this.dispatch({ type: "mousemove", pos: snapPos(e.world), shift: e.shift });
    }
    onPointerUp(e) {
      this.dispatch({ type: "mouseup", pos: snapPos(e.world), button: e.button, shift: e.shift });
    }
    onDoubleClick(e) {
      this.dispatch({ type: "dblclick", pos: snapPos(e.world) });
    }
    onWheel(factor, screenPos) {
      this.view.zoomAt(screenPos, factor);
      this.invalidate();
    }
    onResize() {
      this.invalidate();
    }
    onViewChanged() {
      this.invalidate();
    }
    isPanMode() {
      return this.spaceHeld;
    }
    /* ------------------------------ 状态机驱动 ------------------------------ */
    get fsmState() {
      return this.fsm;
    }
    setTool(kind) {
      this.dispatch({ type: "setTool", kind });
      this.hooks.onToolChanged(kind);
    }
    dispatch(event) {
      const result = transition(this.fsm, event, this);
      this.fsm = result.state;
      for (const action of result.actions) this.handleAction(action);
      this.invalidate();
    }
    /* ------------------------------ 动作处理 ------------------------------ */
    handleAction(action) {
      switch (action.type) {
        case "select":
          this.doc.setSelection(action.selection);
          break;
        case "hover":
          this.hoverPort = action.pos;
          break;
        case "beginDrag":
          break;
        // 预览不落历史，无需快照
        case "place":
          this.doc.addComponentAt(action.kind, action.pos);
          break;
        case "movePreview":
          this.doc.movePreview(action.delta);
          break;
        case "commitMove":
          this.doc.commitMove(action.delta);
          break;
        case "cancelMove":
          this.doc.cancelMove();
          break;
        case "bendPreview": {
          const wireId = this.currentWireDragId();
          if (wireId) this.doc.bendPreviewAt(wireId, action.pos);
          break;
        }
        case "commitBend": {
          const wireId = this.currentWireDragId();
          if (wireId) this.doc.commitBend(wireId, action.pos);
          break;
        }
        case "cancelBend":
          this.doc.cancelBend();
          break;
        case "commitWire": {
          const r = this.doc.addWireBetween(action.from, action.to);
          if (!r.ok) {
            const why = r.reason === "duplicate" ? "\u8FDE\u7EBF\u5DF2\u5B58\u5728" : "\u4E0D\u80FD\u81EA\u8FDE";
            this.hooks.onStatus("\u5E03\u7EBF\u5931\u8D25\uFF1A" + why);
          }
          break;
        }
        case "commitMarquee":
          this.applyMarquee(action.rect, action.additive);
          break;
        case "click": {
          if (action.kind === "component") {
            const comp = this.doc.findComponent(action.id);
            if (comp && comp.kind === "INPUT") {
              this.sim.toggleInput(comp.id);
              this.sim.tick();
            }
          }
          break;
        }
        case "status":
          this.hooks.onStatus(action.message);
          break;
      }
    }
    currentWireDragId() {
      if (this.fsm.name === "dragging" && this.fsm.target === "wire" && this.fsm.clicked) {
        return this.fsm.clicked.id;
      }
      return null;
    }
    /** 框选：相交即选中；additive 与既有选择取并集 */
    applyMarquee(rectUnnormalized, additive) {
      const rect = normalizeRect(rectUnnormalized);
      const compIds = [];
      const wireIds = [];
      for (const comp of this.doc.netlist.components) {
        if (rectsIntersect(rect, componentBoundsOf(comp))) compIds.push(comp.id);
      }
      for (const w of this.doc.netlist.wires) {
        const pts = wirePolyline(this.doc.netlist, w, this.doc.bends);
        if (pts.length >= 2 && rectsIntersect(rect, polylineBounds(pts))) wireIds.push(w.id);
      }
      const base = additive ? this.doc.selection : { components: /* @__PURE__ */ new Set(), wires: /* @__PURE__ */ new Set() };
      const next = unionSelection(base, { components: new Set(compIds), wires: new Set(wireIds) });
      this.doc.setSelection(next);
    }
    /* ------------------------------ 场景与渲染 ------------------------------ */
    oscillating() {
      return this.sim.diagnostics().some((d) => d.kind === "oscillation");
    }
    buildOverlay() {
      const overlay = {};
      if (this.fsm.name === "placing") {
        overlay.ghost = { kind: this.fsm.kind, pos: { x: this.fsm.ghost.x, y: this.fsm.ghost.y } };
      }
      if (this.fsm.name === "wiring") {
        const fromComp = this.doc.findComponent(this.fsm.from.componentId);
        if (fromComp) {
          const fromPos = portPos(fromComp, this.fsm.from.port);
          if (fromPos) {
            const dir = portStubDir(fromComp.kind, this.fsm.from.port) ?? "right";
            const cursor = snapPos(this.fsm.cursor);
            overlay.wirePreview = routeOrthogonal(fromPos, dir, cursor, nearestDir(fromPos, cursor));
          }
        }
      }
      if (this.fsm.name === "marquee") {
        overlay.marquee = rectFromPoints(this.fsm.start, this.fsm.current);
      }
      if (this.hoverPort) {
        overlay.hoverPort = { x: this.hoverPort.x, y: this.hoverPort.y };
      }
      return overlay;
    }
    render() {
      const rc = new CanvasAdapter(this.view.rawContext);
      const effective = applyPreviewDelta(this.doc.netlist, this.doc.selection.components, this.doc.previewDelta);
      const bends = this.doc.bendPreview ? new Map([...this.doc.bends, [this.doc.bendPreview.wireId, this.doc.bendPreview.pos]]) : this.doc.bends;
      const scene = {
        netlist: effective,
        selection: this.doc.selection,
        values: this.sim.values,
        diags: projectDiagnostics(this.sim.diagnostics()),
        overlay: this.buildOverlay(),
        view: {
          pan: this.view.pan,
          zoom: this.view.zoom,
          width: this.view.width,
          height: this.view.height
        },
        bends,
        time: Date.now()
      };
      this.dirty = false;
      drawScene(rc, scene);
    }
    invalidate() {
      this.dirty = true;
    }
    /* ------------------------------ 引擎同步与自动保存 ------------------------------ */
    syncEngine() {
      this.sim.setNetlistRef(this.doc.netlist);
      this.sim.syncNetlist(this.doc.netlist);
      this.sim.tick();
    }
    scheduleSave() {
      if (this.saveTimer !== null) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => {
        saveLocal(this.doc.netlist);
        this.saveTimer = null;
      }, 500);
    }
    /* ------------------------------ 键盘快捷键 ------------------------------ */
    bindKeyboard() {
      window.addEventListener("keydown", (e) => {
        const target = e.target;
        const isFormField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
        if (isFormField) return;
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.code === "Space" && !e.repeat) {
          this.spaceHeld = true;
          e.preventDefault();
          return;
        }
        if (e.key === "Escape") {
          this.dispatch({ type: "cancel" });
          return;
        }
        if (ctrl && !e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          this.doc.undo();
          return;
        }
        if (ctrl && e.key.toLowerCase() === "y" || ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          this.doc.redo();
          return;
        }
        if (ctrl && e.key.toLowerCase() === "c") {
          e.preventDefault();
          this.lastCopyText = this.doc.copyToText();
          writeSystemClipboard(this.lastCopyText);
          this.hooks.onStatus("\u5DF2\u590D\u5236 " + this.doc.selection.components.size + " \u4E2A\u7EC4\u4EF6");
          return;
        }
        if (ctrl && e.key.toLowerCase() === "x") {
          e.preventDefault();
          this.lastCopyText = this.doc.copyToText();
          writeSystemClipboard(this.lastCopyText);
          this.doc.deleteSelection();
          return;
        }
        if (ctrl && e.key.toLowerCase() === "v") {
          e.preventDefault();
          if (this.lastCopyText) {
            const n = this.doc.pasteFromText(this.lastCopyText, gridOffset());
            const msg = n >= 0 ? "\u5DF2\u7C98\u8D34 " + n + " \u4E2A\u7EC4\u4EF6" : "\u526A\u8D34\u677F\u4E3A\u7A7A";
            this.hooks.onStatus(msg);
          }
          return;
        }
        if (ctrl && e.key.toLowerCase() === "d") {
          e.preventDefault();
          const text = this.doc.copyToText();
          const n = this.doc.pasteFromText(text, gridOffset());
          const msg = n >= 0 ? "\u5DF2\u521B\u5EFA\u526F\u672C " + n + " \u4E2A" : "\u65E0\u9009\u4E2D\u5185\u5BB9";
          this.hooks.onStatus(msg);
          return;
        }
        if (ctrl && e.key.toLowerCase() === "a") {
          e.preventDefault();
          this.doc.setSelection({
            components: new Set(this.doc.netlist.components.map((c) => c.id)),
            wires: new Set(this.doc.netlist.wires.map((w) => w.id))
          });
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          this.doc.deleteSelection();
          return;
        }
        if (e.key === "+" || e.key === "=") {
          this.view.setZoomAtCenter(this.view.zoom * 1.2);
          this.invalidate();
          return;
        }
        if (e.key === "-") {
          this.view.setZoomAtCenter(this.view.zoom / 1.2);
          this.invalidate();
          return;
        }
        if (singleDigit(e.key)) {
          const idx = Number(e.key);
          const kinds = toolKindsList();
          const kind = kinds[idx - 1] ?? SELECT_TOOL;
          this.setTool(kind === SELECT_TOOL ? null : kind);
          return;
        }
      });
      window.addEventListener("keyup", (e) => {
        if (e.code === "Space") {
          this.spaceHeld = false;
        }
      });
    }
    /* ------------------------------ 画布绑定 ------------------------------ */
    bindCanvasView() {
      this.view.attach({
        onPointerDown: (e) => this.onPointerDown(e),
        onPointerMove: (e) => this.onPointerMove(e),
        onPointerUp: (e) => this.onPointerUp(e),
        onDoubleClick: (e) => this.onDoubleClick(e),
        onWheel: (f, s) => this.onWheel(f, s),
        onResize: () => this.onResize(),
        onViewChanged: () => this.invalidate(),
        isPanMode: () => this.isPanMode()
      });
    }
  };
  function distToPolyline(p3, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p3.x - a.x) * dx + (p3.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p3.x - (a.x + t * dx), p3.y - (a.y + t * dy)));
    }
    return best;
  }
  function nearestDir(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "down" : "up";
  }
  function gridOffset() {
    return { x: 2 * GRID, y: 2 * GRID };
  }
  function writeSystemClipboard(text) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        void navigator.clipboard.writeText(text).catch(() => {
        });
      }
    } catch {
    }
  }
  function singleDigit(key) {
    return key.length === 1 && key >= "1" && key <= "9";
  }
  function toolKindsList() {
    return [SELECT_TOOL, ...listShapeKinds()];
  }

  // src/hack/programs/movblk.hack
  var movblk_default = "0000000000011100\n1110110000010000\n0000000000010000\n1110001100001000\n0000000001111100\n1110110000010000\n0000000000010001\n1110001100001000\n0000000000000001\n1110110000010000\n0000000000010010\n1110001100001000\n0000000000000001\n1110110000010000\n0000000000010011\n1110001100001000\n0000000000010100\n1110111010001000\n0000000000010001\n1111110000010000\n0100000000000000\n1110000010010000\n0000000000010101\n1110001100001000\n0000000000000000\n1110110000010000\n0000000000010110\n1110001100001000\n0000000000010101\n1111110000100000\n1110101010001000\n0000000000010101\n1111110000010000\n0000000000100000\n1110000010010000\n0000000000010101\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000010110\n1110001100001000\n0000000000010000\n1110010011010000\n0000000000011100\n1110001100000100\n0000000000010000\n1111110000010000\n0000000000010010\n1111000010010000\n0000000000010000\n1110001100001000\n0000000000010000\n1111110000010000\n0000000000011111\n1110010011010000\n0000000001000001\n1110001100000011\n0000000000010000\n1111110000010000\n0000000001000111\n1110001100000100\n0000000001001011\n1110101010000111\n0000000000010100\n1111110000010000\n0000000000010010\n1110001100001000\n0000000001001011\n1110101010000111\n0000000000000001\n1110110000010000\n0000000000010010\n1110001100001000\n0000000000010010\n1111110000010000\n0000000000010001\n1111000010001000\n0000000000010001\n1111110000010000\n0000000000011111\n1110010011010000\n0000000001011101\n1110001100000110\n0000000000010001\n1111110000010000\n0001111000100000\n1110010011010000\n0000000001100011\n1110001100000011\n0000000001100111\n1110101010000111\n0000000000000001\n1110110000010000\n0000000000010011\n1110001100001000\n0000000001100111\n1110101010000111\n0000000000010100\n1111110000010000\n0000000000010011\n1110001100001000\n0000000000010011\n1111110000010000\n0000000000000001\n1110010011010000\n0000000001110101\n1110001100000101\n0000000000010001\n1111110000010000\n0000000000100000\n1110000010010000\n0000000000010001\n1110001100001000\n0000000001111011\n1110101010000111\n0000000000010001\n1111110000010000\n0000000000100000\n1110010011010000\n0000000000010001\n1110001100001000\n0000000000010001\n1111110000010000\n0100000000000000\n1110000010010000\n0000000000010101\n1110001100001000\n0000000000000000\n1110110000010000\n0000000000010110\n1110001100001000\n0000000000010101\n1111110000100000\n1110111010001000\n0000000000010101\n1111110000010000\n0000000000100000\n1110000010010000\n0000000000010101\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000010110\n1110001100001000\n0000000000010000\n1110010011010000\n0000000010000101\n1110001100000100\n0000000000000000\n1110110000010000\n0000000000010111\n1110001100001000\n0000000000010111\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000010111\n1110001100001000\n0000000011001000\n1110010011010000\n0000000010011100\n1110001100000100\n0000000000010010\n1110101010000111\n";

  // src/hack/programs/tetris.hack
  var tetris_default = "0000000100000000\n1110110000010000\n0000000000000000\n1110001100001000\n0000000000101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100110001101011\n1110101010000111\n0000000000101110\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000000001001010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000000001001101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000010001011\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000010111110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000110000111000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100100011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000000001111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0110000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000110001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000011110100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0111111111111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010000\n1110001100001000\n0000000000010000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000001000101000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000001000101011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000001001110001\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000001011001011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000001011001110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000001100010001\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000001101101011\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0000001101101110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000001110110001\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000010001111000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000010001111011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000010101000001\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000010011010000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000010011010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000010011111100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000010001011100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000010110110110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000010110111001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000010111111001\n1110001100000101\n0111111111111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011000110101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000011000111000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000011010011110\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011001111110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000011010000001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000011010011110\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011010111000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000011010111011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000011011100010\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011100000001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000011100000100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000100000000010\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011100101011\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000011100101110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000011111001100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000011101010000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000011101010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000011110010110\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000100000011100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000100000011111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000100000100110\n1110001100000101\n0000100001000000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000100001010101\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000100010100001\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000100010100100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000101001110011\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000100011010101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000100011011000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000100011100010\n1110001100000101\n0000100011110100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000100100000100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000100101110101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000100101111000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000100101111111\n1110001100000101\n0000100111000100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000101000101110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000100111100011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000100111100110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000101000101110\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000100010000101\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000101010001101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000101010010000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000101011010110\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0011111100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000101110100001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000101110100100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000110000000110\n1110001100000101\n0000100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011011100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010010\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010001\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000110001101110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000110001110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000110010101111\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000110100001100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000110100001111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000111111011001\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000110101111011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000110101111110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000111110100100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000110111010010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0000110111010101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000110111011111\n1110001100000101\n0000111010011100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000111001001101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000111001010000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000111001010111\n1110001100000101\n0000111001100111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010010\n1110001100001000\n0000111010011010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000111100101010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0000111010110110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0000111010111001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000111011000000\n1110001100000101\n0000111011011001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010010\n1110001100001000\n0000111100010101\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000110011110010\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000100000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001000000101111\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001000000110010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001000001101100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010010\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0001000111100100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010010000011101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001001000011001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100001011011111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010011\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010100\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010101\n1110001100001000\n0001001001011010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011010000001001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001001010101011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001001010101110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001001011000110\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001001011100010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001001011100101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001001011111100\n1110001100000101\n0000000000111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001001100010110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001001100011001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001001100110001\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001001101001101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001001101010000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001001101100111\n1110001100000101\n0000000000011111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010100\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010001000001\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0001010001000100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001010010010100\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001111011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010001101000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001010001101011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001010010010100\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010010110000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001010010110011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001111110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010011001111\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0001010011010010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001010100010110\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000101111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010100110010\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0001010100110101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000111010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010101010001\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001010101010100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001010110110011\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001010111001111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001010111010010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011000010010\n1110001100000101\n0000000000001011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001011000101110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001011000110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011001110001\n1110001100000101\n0000000000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001011010001101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001011010010000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011011010000\n1110001100000101\n0000000000001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001011011101100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001011011101111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011100101111\n1110001100000101\n0000000000001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001011101001011\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001011101001110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011110001110\n1110001100000101\n0000000000001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001011110101010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001011110101101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001011111101101\n1110001100000101\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100000001001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100000001100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001100001001100\n1110001100000101\n0000000000010001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100001101000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100001101011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001100010101011\n1110001100000101\n0000000000010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100011000111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100011001010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001100100001010\n1110001100000101\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100100100110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100100101001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001100101101001\n1110001100000101\n0000000000010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100110000101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100110001000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001100111001000\n1110001100000101\n0000000000010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001100111100100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001100111100111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001101000100111\n1110001100000101\n0000000000010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001101010111110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0001101011101000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001111000100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001101100110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001101101110010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0001101110011100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001101111111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001101111011010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0001101111011101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0010000011100111\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110000100001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010110100011100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000010101111100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110010110100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110100001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0001110100110100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0001110100110111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0001110100111110\n1110001100000101\n0001111101000101\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110101110111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001110111011010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000011110100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0001111000111101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000101010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001111001111011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001111011011011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000011110100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0001111100111110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000101010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0010000011000110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0001111110011100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000011110100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0010000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000101010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010000001011011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000011110100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0010000011000001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000101010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001101110111110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010000101001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001010000100101\n1110101010000111\n0000000000010100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010000110000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001000\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001101001011101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010100\n1110001100001000\n0000000000010100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0010000110110101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0010000110111000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0010001000000111\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010100\n1110001100001000\n0000000000010101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010101\n1110001100001000\n0000000000010101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0010000111110100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0010000111110111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0010001000000111\n1110001100000101\n0000000000011111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010001001110100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010010001011\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0010001010101111\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0010001010110010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0010001101000110\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010001011110110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010011001101\n1110101010000111\n0010001100100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010000100011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0010001010010000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010001110110001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100011110110110\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010001111100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001000111001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000001011100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010010001001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010110\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010110\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010110\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010110\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000010110\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110111001110110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000111000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000001111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011000011100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000110000011100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001101100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000010111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111110000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001110000110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000011111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000110000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011000111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000100111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011000111110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000101111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000110111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000000111111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110001101110111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111101101011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110001101100011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110001100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001000111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111100001101100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001001111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000000111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0111111000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000011000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001010111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001011000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011001100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001011001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110011000111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001011010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0001100000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010110\n1111110000010000\n0000000001011011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010110101011011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010111\n1110001100001000\n0000001000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010110111110101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011000\n1110001100001000\n0000001000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010111000101010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011001\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010111001011111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011010\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010111010010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011011\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010111011001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011100\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000011010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0010111100010000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0010111100010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0010111111000010\n1110001100000101\n0000000000011010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000011010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0010111011110100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000011011\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011010\n1111110000010000\n0000000000001111\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011000000100101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011000000101000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011000101101001\n1110001100000101\n0000000000011011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000011011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000011100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011000000001001\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000001000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011000110110101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011000110111000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011001010110100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011001001011001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011001001011100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011001010010011\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011000110011001\n1110101010000111\n0011001011011110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011010000001001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011001100101111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011001100110010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011001100111001\n1110001100000101\n0011001101000100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010111\n1110001100001000\n0011001101001101\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000010111\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000011000\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000011001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0100000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0010000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011010001001111\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011010001010010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011010010101000\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011010000110011\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011010100000000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011010100000011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000111111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011010100011111\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011010100100010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011010101000010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011010101000101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011010101100111\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011010101101010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011010110101010\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0100000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0011010111101001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000011000\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011011010001110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011011010010001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011011010011000\n1110001100000101\n0011011011000111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011011011110111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011011101100011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011011101100110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011011101111110\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000111111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011011110011010\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011011110011101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011011110110111\n1110001100000101\n0000000111111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011011111010110\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011011111011001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011100000010011\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000011000\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011000\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011100100110110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011100100111001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011101000100011\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011100101110110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011100101111001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011100110000000\n1110001100000101\n0011100111000001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011100111110001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011101001011000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011101001011011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011101001100010\n1110001100000101\n0011101010010001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011101011000001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011101100101101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011101100110000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011101111010000\n1110001100000101\n0000000000010111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011101101001111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011101101010010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011101101011001\n1110001100000101\n0011101101110111\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011101110010000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011101100001110\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011110000101001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0011110000101100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011110000110011\n1110001100000101\n0011110001100010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011110010010010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011110011101111\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011110011110010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011110100111001\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011110101011000\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011110101011011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011110110100010\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011110110111100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011110110111111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011110111010111\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011110111110011\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0011110111110110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011111000010000\n1110001100000101\n0000000011111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100000000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0011111001001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0011111010010101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0011111010011000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0011111100101001\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0011111011100010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001000\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011011100101001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0011111001110110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0011111110110101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001000001110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0100000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001000001110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100000000101110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100000000110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100000000111000\n1110001100000101\n0100000001001010\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100000001011101\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100000001111100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100000001111111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100000010000110\n1110001100000101\n0100000010011000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100000010101011\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100000011101110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0100000011110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100000100010000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0100000100010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000000001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100001001101100\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100000101011010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011010011011010\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100000110100101\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0100000110101000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100000111111000\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100001000010111\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100001000011010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100001001101010\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100000011001111\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100001010101000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011010011011010\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100001100001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000110000111000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100001100101110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100001100110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100001101001001\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100001110100001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000110000111000\n1110101010000111\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100010000011111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000000001111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100010001010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000000001111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100010011110010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100010011110101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100010100010100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100010100010111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100010101011110\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100010111110000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100010111110011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100011000110000\n1110001100000101\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100011011101010\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0100011011101101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100011100010100\n1110001100000101\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100100000001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100100001011111\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100100001100010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100100011110100\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010100000\n1111110011001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100100010101100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100100010101111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100100011110100\n1110001100000101\n0000000000111000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000110011001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100100100001110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0100100100010001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100100101000100\n1110001100000101\n0000000000110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100100101011110\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0100100101100001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100101001110110\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100100110100010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000010101111100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100100111110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100100101000100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100101010010000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0100101010010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100101100100011\n1110001100000101\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100101010111010\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100101010111101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100101100100011\n1110001100000101\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000101101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100101100111101\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0100101101000000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100110000000001\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0100101110000110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0100101110001001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100101111111111\n1110001100000101\n0000000000000011\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000001101\n1111000010010000\n0000000000000100\n1110001100001000\n1110001100100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000011\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0100101100100011\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100110000110100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000011110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0100110010010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000101110000110\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0100110011000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000110111100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0100110011110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010110110110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0100110100100010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001000110111010\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0100110101010001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100110111111010\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0100110110000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100110110110111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0100110111001000\n1110001100000101\n0100110110110111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0100111000100100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0111011101000101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000011001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100111010101011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011101\n1110001100001000\n0000000011100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0100111011100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000110000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011110\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0100111100110111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0100111110001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0100111111100101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0101000000111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0101000010010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0101000011101010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0101000101000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101010101011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101000101110100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101000101110111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101010100001000\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101000110011001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0101000110011100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101000110100011\n1110001100000101\n0101000110110111\n1110101010000111\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101000111001001\n1110101010000111\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101000111110101\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101000111111000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101010011100111\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101001000101100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101001000101111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101010011000110\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101001001110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101001010101111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101001101111100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0101001101111111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101001110000110\n1110001100000101\n0101010000001110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101010010100011\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101001000010000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101000111011001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101000101011000\n1110101010000111\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000011111\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100000\n1110001100001000\n0000001011101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100001\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101010110100001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101011000000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101011001101001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101011011010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101011100111111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000110\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101011110101010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000111\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101100000010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000001000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101100010000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101100100001000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0101100100001011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101100100110001\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101100011101110\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101100110101100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101100111101011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101101000100011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101101000100110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101110010000011\n1110001100000101\n0000000000000010\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101101011101100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101101011101111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101101100001011\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0101101100001110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111010101001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101101101010010\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101101101101110\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0101101101110001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101101110101111\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101101111101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101110000100010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0101110000100101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101110001100000\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101101000000111\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000100010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100010\n1110001100001000\n0000000000100010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101110100001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000010101111100\n1110101010000111\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101110100111101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100011\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100100\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100110\n1110001100001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101110110100111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101100101100011\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0101110110110101\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100111\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101111000101101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101111001101001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0101111010100001\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0101111010100100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0101111111100010\n1110001100000101\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0101111110011001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0101111010000101\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110000001100100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110000001100111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110001111001101\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110000010101011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110000010101110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110000101100101\n1110001100000101\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110000011110101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110000100101001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110000100101100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110000101000100\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000010001111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110000101111111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110000110000010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110001110101100\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110000111010101\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0110000111011000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110001100101010\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110001000001100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110001000001111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110001100001001\n1110001100000101\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110001001100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110001011000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000111110000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000110111011\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110001101010110\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110001101011001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110001110101100\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110001100111010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110000001001000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110001111100111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110001111101010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110010100001010\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110010000001001\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110010000001100\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110010000010011\n1110001100000101\n0110010000101100\n1110101010000111\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000001100100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101000\n1110001100001000\n0110010011000001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110010001001000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110010001001011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110010001010010\n1110001100000101\n0110010001101011\n1110101010000111\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000100101100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101000\n1110001100001000\n0110010011000001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110010010000111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110010010001010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110010010010001\n1110001100000101\n0110010010101010\n1110101010000111\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000111110100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101000\n1110001100001000\n0110010011000001\n1110101010000111\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000001100100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101000\n1110001100001000\n0000000000101001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101001\n1110001100001000\n0110010100000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110110101101000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000101010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101010\n1110001100001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0110010110100001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101100101100011\n1110101010000111\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110010110101011\n1110001100000101\n0110011001011001\n1110101010000111\n0110010111010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101110111100111\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0110011000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110000000010100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000100111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110011000100000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110011000100011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110011001010111\n1110001100000101\n0110011001010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101110010111100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0110011001101110\n1110101010000111\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100110\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101011\n1110001100001000\n0011111100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000101010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000101001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000110\n1110000010010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0110011110100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001100010101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000010\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0110100000010001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0110100010001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001100010101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000010000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011110111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110100011010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0110100100001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001100010101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110100101001011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110100101001110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110101011011111\n1110001100000101\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110100110010100\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110100110010111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110101010011101\n1110001100000101\n0000000000011101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110100111011110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110101000010010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110101000010101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110101001011011\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110101001010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110011101111000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000011\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110100101111000\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000100\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110100100101111\n1110101010000111\n0000000000100111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110101011110110\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0110101011111001\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110110100101101\n1110001100000101\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110101100110100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110101101110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0110101110101000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0110101110101011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0110110100101101\n1110001100000101\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000101\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000001\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110110010010000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000010\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110110011010101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000001111101100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0110110100000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110011101111000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0110101110001100\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101011\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110110110011110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001001010010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110110111010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100001011011111\n1110101010000111\n0000000001010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111000110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111001100011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111010010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111011000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0110111011101101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001000111001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111100101000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001001010010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000101000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111101011101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001101111000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111110010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010000100011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000100000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0110111111000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010000100011001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0111000000101100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011001100010101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000010001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000001110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000010111010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000010001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000010001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000100000001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000001110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000010001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000011111001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000101001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011110011000100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0111000110000001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001001010010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000110110110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100001011011111\n1110101010000111\n0000000001010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111000111100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001000010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001001000110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001001110110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001001001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001010100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001011010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0111001100000000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001000111001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111001100101111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110110101101000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111001110110111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101100101100011\n1110101010000111\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111001111100010\n1110001100000101\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101011\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000100100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111010001010000\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111010001010011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111010001101011\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000100011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111010010110000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000001001\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101100101100011\n1110101010000111\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111010011001111\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100100\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101011\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0111010100101111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000101011010\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000101100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111010101010111\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111010101011010\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111010101101000\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111010110000010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111010110000101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111011011111100\n1110001100000101\n0000000000101101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101101\n1110001100001000\n0000000000101101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111010110111000\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0111010110111011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111011011001111\n1110001100000101\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111010111011100\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111010111011111\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111010111100110\n1110001100000101\n0111011000011110\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010100000\n1111110011001000\n0111011000010111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0111001101100110\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111011011001111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111011000111010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111011000111101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111011001000100\n1110001100000101\n0111011001111001\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0111011001110010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0111001101100110\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111011011001111\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111011010010101\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111011010011000\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111011011001111\n1110001100000101\n0111011011001010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0111010000010100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000101101\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111011011101000\n1110001100000001\n0000000000000000\n1111110010100000\n1110101010001000\n0111011011101011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111011011111100\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101101\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101100\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0111011101110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100111001011011\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111011110100010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0011010000001001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111011111010001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110111111111110\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100111\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101100\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101110\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101010\n1110001100001000\n0000000000000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000100010\n1110001100001000\n0111100000111000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101110010111100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111100001100111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110100001001000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000100111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111100010000011\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111100010000110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111101000111000\n1110001100000101\n0111100010110101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0111010100000001\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010010000\n0000000000001101\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000001101\n1111110000100000\n1110001100001000\n0000000000101110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110111111001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101110\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1110000010100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000101000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111100011110010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111100011110101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111100011111111\n1110001100000101\n0111100101011010\n1110101010000111\n0000000000101110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000011111\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111100100011000\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0111100100011011\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111100101011000\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101110\n1110001100001000\n0111100101010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110010100111100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111100110110011\n1110101010000111\n0000000000101110\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000100000\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111100101110011\n1110001100000100\n0000000000000000\n1111110010100000\n1110101010001000\n0111100101110110\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111100110110011\n1110001100000101\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000101110\n1110001100001000\n0111100110101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110010100111100\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000101011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000000\n1111110010100000\n1111000111010000\n0111100111001010\n1110001100000010\n0000000000000000\n1111110010100000\n1110101010001000\n0111100111001101\n1110101010000111\n0000000000000000\n1111110010100000\n1110111010001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111101000000001\n1110001100000101\n0111100111111100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110100001001000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000100001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101000110001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0101100011010101\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111100001101100\n1110101010000111\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101001101110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001001010010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101010100011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100001011011111\n1110101010000111\n0000000001000111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101011010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000001\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101100000011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101100110011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101101100011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0111101110001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001000111001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000010011\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000010100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101111001000\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0001001010010001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000100\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111101111111101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100001011011111\n1110101010000111\n0000000001001111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111110000101101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111110001011101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001000101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111110010001101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0000000001010010\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0111110010111101\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000111\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0100010111000110\n1110101010000111\n0111110011100111\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000110\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0010001000111001\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0111110100010110\n1110110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000001\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000011\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000100\n1111110000010000\n0000000000000000\n1111110111001000\n1111110010100000\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000101\n1110010011010000\n0000000000000010\n1110001100001000\n0000000000000000\n1111110000010000\n0000000000000001\n1110001100001000\n0110110101101000\n1110101010000111\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000101\n1110001100001000\n0000000000000000\n1111110111001000\n1111110010100000\n1110101010001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010100000\n1111110001001000\n0000000000000000\n1111110010101000\n1111110000010000\n0111110100101100\n1110001100000101\n0111110100011011\n1110101010000111\n0000000000000001\n1111110000010000\n0000000000001101\n1110001100001000\n0000000000000101\n1110010011100000\n1111110000010000\n0000000000001110\n1110001100001000\n0000000000000000\n1111110010101000\n1111110000010000\n0000000000000010\n1111110000100000\n1110001100001000\n0000000000000010\n1111110000010000\n0000000000000000\n1110011111001000\n0000000000001101\n1111110000010000\n0000000000000001\n1110010011100000\n1111110000010000\n0000000000000100\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000010\n1110010011100000\n1111110000010000\n0000000000000011\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000011\n1110010011100000\n1111110000010000\n0000000000000010\n1110001100001000\n0000000000001101\n1111110000010000\n0000000000000100\n1110010011100000\n1111110000010000\n0000000000000001\n1110001100001000\n0000000000001110\n1111110000100000\n1110101010000111\n";

  // src/hack/programs/kbdcopy.hack
  var kbdcopy_default = "0110000000000000\n1111110000010000\n0100000000000000\n1110001100001000\n";

  // src/hack/programs/sum.hack
  var sum_default = "0000000000000001\n1110101010001000\n0000000000010000\n1110111111001000\n0000000000010000\n1111110000010000\n0000000000000000\n1111010011010000\n0000000000010100\n1110001100000001\n0000000000000001\n1111110000010000\n0000000000010000\n1111000010010000\n0000000000000001\n1110001100001000\n0000000000010000\n1111110111001000\n0000000000000100\n1110101010000111\n0000000000010100\n1110101010000111\n";

  // src/web/main.ts
  var DEMOS = [
    { id: "movblk", title: "\u2460 \u5F39\u8DF3\u65B9\u5757\uFF08\u70B9\u5C4F\u52A8\u6548\uFF09", desc: "16\xD716 \u65B9\u5757\u5BF9\u89D2\u5F39\u8DF3\uFF0C\u81EA\u7F16 Hack \u6C47\u7F16", program: movblk_default },
    { id: "tetris", title: "\u2461 \u4FC4\u7F57\u65AF\u65B9\u5757", desc: "nand-computer \u8F6F\u4EF6\u8F68\u7F16\u8BD1\u4EA7\u7269\uFF08boot \u6570\u767E\u4E07\u5468\u671F\uFF0C\u8BF7\u8010\u5FC3\uFF1B\u65B9\u5757\u5728\u79FB\u52A8/\u843D\u5E95\u65F6\u7ED8\u5236\uFF09", program: tetris_default },
    { id: "kbdcopy", title: "\u2462 \u952E\u76D8\u56DE\u663E", desc: "KBD \u2192 SCREEN[0]\uFF0C\u6309\u952E\u8BD5\u8BD5", program: kbdcopy_default },
    { id: "sum", title: "\u2463 \u6C42\u548C\u7A0B\u5E8F", desc: 'RAM[1] = 1+2+\u2026+RAM[0]\uFF08R0=10 \u2192 55\uFF09\uFF0C\u8DD1\u5B8C\u70B9"\u8BFB RAM 0..2"', program: sum_default, ramInit: { 0: 10 } }
  ];
  var engine = createEngine();
  var machine;
  var screen;
  var running = false;
  var cyclesPerFrame = 800;
  var totalCycles = 0;
  var circuitDoc = null;
  var circuitSim = null;
  var $ = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`\u9875\u9762\u7F3A\u5143\u7D20 #${id}`);
    return el;
  };
  function startDemo(def) {
    machine = new HackMachine(engine, {
      program: def.program,
      ramInit: def.ramInit,
      handleIds: { rom: "web-rom", ram: "web-ram", screen: "web-screen" }
    });
    window.__mach = machine;
    totalCycles = 0;
    $("demoDesc").textContent = def.desc;
    $("statRam1").textContent = "\u2014";
    attachCircuitView();
    renderStats();
  }
  function attachCircuitView() {
    const canvasEl = document.getElementById("circuit");
    if (!canvasEl) return;
    if (circuitDoc === null) {
      registerChipShapes();
      circuitDoc = new NetlistDoc(machine.netlist);
      circuitSim = new SimController(engine);
      circuitSim.setNetlistRef(machine.netlist);
      const view = new CanvasView(canvasEl);
      void new Controller(circuitDoc, circuitSim, view, {
        onStatus: (msg) => {
          $("cirStatus").textContent = msg;
        },
        onSelectionChanged: () => {
        },
        onToolChanged: () => {
        },
        onSimEvent: () => {
        }
      });
    } else {
      circuitDoc.commit(machine.netlist);
    }
  }
  function frame() {
    if (!running) return;
    const budgetMs = 12;
    const t0 = performance.now();
    let n = 0;
    while (n < cyclesPerFrame && performance.now() - t0 < budgetMs) {
      machine.cycle();
      n++;
    }
    totalCycles += n;
    screen.render(machine.screen.words);
    circuitSim?.refreshValues();
    renderStats();
    requestAnimationFrame(frame);
  }
  function renderStats() {
    $("statCycles").textContent = totalCycles.toLocaleString();
    $("statPc").textContent = `0x${machine.readPc().toString(16).padStart(4, "0")}`;
    $("statA").textContent = `0x${machine.readA().toString(16).padStart(4, "0")}`;
    $("statD").textContent = machine.readD().toString();
  }
  function wireUi() {
    const menu = $("demoSelect");
    for (const d of DEMOS) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.title;
      menu.appendChild(opt);
    }
    menu.onchange = () => {
      const def = DEMOS.find((d) => d.id === menu.value);
      running = false;
      startDemo(def);
      screen.render(machine.screen.words);
      $("btnRun").textContent = "\u25B6 \u8FD0\u884C";
    };
    $("btnRun").onclick = () => {
      running = !running;
      $("btnRun").textContent = running ? "\u23F8 \u6682\u505C" : "\u25B6 \u8FD0\u884C";
      if (running) requestAnimationFrame(frame);
    };
    $("btnReset").onclick = () => {
      machine.engine.reset();
      totalCycles = 0;
      screen.render(machine.screen.words);
      circuitSim?.refreshValues();
      renderStats();
    };
    $("btnStep").onclick = () => {
      machine.cycle();
      totalCycles++;
      screen.render(machine.screen.words);
      circuitSim?.refreshValues();
      renderStats();
    };
    const speed = $("speed");
    speed.oninput = () => {
      cyclesPerFrame = Number(speed.value);
      $("speedVal").textContent = String(cyclesPerFrame);
    };
    window.addEventListener("keydown", (e) => {
      const target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      const code = hackKeyCode(e);
      if (code < 0) return;
      e.preventDefault();
      machine.setKbd(code);
      $("kbdNow").textContent = `${code}${e.key.length === 1 ? ` ('${e.key}')` : ` (${e.key})`}`;
    });
    window.addEventListener("keyup", () => {
      machine.setKbd(0);
      $("kbdNow").textContent = "\u2014";
    });
    $("btnRam").onclick = () => {
      $("statRam1").textContent = `R0=${machine.ramValue(0)} R1=${machine.ramValue(1)} R2=${machine.ramValue(2)}`;
    };
  }
  function boot() {
    const canvas = $("screen");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D \u4E0A\u4E0B\u6587\u4E0D\u53EF\u7528");
    screen = new ScreenView(ctx);
    wireUi();
    startDemo(DEMOS[0]);
    screen.render(machine.screen.words);
  }
  void boot();
})();
