/**
 * 序列化：Netlist ↔ JSON 字符串。
 *
 * - serializeNetlist：直接 JSON.stringify（字段顺序即键插入顺序，无损）。
 * - parseNetlist：容错解析。结构非法（JSON 语法错误、字段缺失/类型不对）不抛异常，
 *   而是返回诊断。诊断 kind 枚举是冻结的四值，结构错误就近映射到 'unknown-kind'
 *   （语义："无法识别的输入"），决策已记录在 README-偏差记录.md。
 * - round-trip 无损性由模糊属性测试保证（随机网表 500 次 parse∘serialize ≡ id）。
 *
 * 语义校验（未知 kind、断线、悬空、冲突……）不在本模块：那属于 buildCircuit/validateNetlist，
 * load() 时统一进行。
 */

import type { ComponentInstance, Diagnostic, Netlist, PortRef, Wire } from '../contract';
import { validateNetlist } from './netlist';

/** 结构校验器：通过则返回规范化对象，否则把问题记入诊断并返回 null */
export function parseNetlist(json: string): { netlist: Netlist | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string): { netlist: Netlist | null; diagnostics: Diagnostic[] } => {
    diagnostics.push({ level: 'error', kind: 'unknown-kind', message });
    return { netlist: null, diagnostics };
  };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return fail(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return fail('网表必须是 JSON 对象');
  }
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj['components'])) return fail('网表缺少 components 数组');
  if (!Array.isArray(obj['wires'])) return fail('网表缺少 wires 数组');

  const components: ComponentInstance[] = [];
  obj['components'].forEach((raw, i) => {
    const inst = parseComponent(raw);
    if (inst === undefined) {
      diagnostics.push({
        level: 'error',
        kind: 'unknown-kind',
        message: `components[${i}] 结构非法（需要 { id, kind, pos: {x, y}, props }）`,
      });
      return;
    }
    components.push(inst);
  });

  const wires: Wire[] = [];
  obj['wires'].forEach((raw, i) => {
    const wire = parseWire(raw);
    if (wire === undefined) {
      diagnostics.push({
        level: 'error',
        kind: 'unknown-kind',
        message: `wires[${i}] 结构非法（需要 { id, from: {componentId, port}, to: {componentId, port} }）`,
      });
      return;
    }
    wires.push(wire);
  });

  return { netlist: { components, wires }, diagnostics };
}

function parseComponent(raw: unknown): ComponentInstance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const { id, kind } = o;
  if (typeof id !== 'string' || typeof kind !== 'string') return undefined;
  const posRaw = o['pos'];
  if (typeof posRaw !== 'object' || posRaw === null) return undefined;
  const pos = posRaw as Record<string, unknown>;
  if (typeof pos['x'] !== 'number' || typeof pos['y'] !== 'number') return undefined;
  const propsRaw = o['props'] ?? {};
  if (typeof propsRaw !== 'object' || propsRaw === null) return undefined;
  const props: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(propsRaw as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'string') props[k] = v;
  }
  return { id, kind, pos: { x: pos['x'] as number, y: pos['y'] as number }, props };
}

function parsePortRef(raw: unknown): PortRef | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o['componentId'] !== 'string' || typeof o['port'] !== 'string') return undefined;
  return { componentId: o['componentId'], port: o['port'] };
}

function parseWire(raw: unknown): Wire | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o['id'] !== 'string') return undefined;
  const from = parsePortRef(o['from']);
  const to = parsePortRef(o['to']);
  if (!from || !to) return undefined;
  return { id: o['id'], from, to };
}

/** 序列化为 JSON 字符串（紧凑格式） */
export function serializeNetlist(netlist: Netlist): string {
  return JSON.stringify(netlist);
}

export { validateNetlist };
