/**
 * 存档序列化（M5）
 * Netlist JSON 下载/上传的文本层：序列化 + 严格校验解析（round-trip 无损）。
 */

import type { Netlist } from '../contract.js';

/** 存档文件扩展名 */
export const ARCHIVE_EXT = '.cir.json';

export type ParseResult =
  | { ok: true; netlist: Netlist }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 序列化（稳定键序由字面量构造保证；JSON.stringify 无空格紧凑） */
export function serializeNetlist(nl: Netlist): string {
  return JSON.stringify({
    format: 'cir-canvas-netlist',
    version: 1,
    components: nl.components.map((c) => ({ id: c.id, kind: c.kind, pos: { x: c.pos.x, y: c.pos.y }, props: c.props })),
    wires: nl.wires.map((w) => ({
      id: w.id,
      from: { componentId: w.from.componentId, port: w.from.port },
      to: { componentId: w.to.componentId, port: w.to.port },
    })),
  });
}

/** 解析 + 校验：结构非法/类型不符一律拒绝（返回 error 消息） */
export function parseNetlist(text: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(obj)) return { ok: false, error: '存档顶层必须是对象' };
  const componentsRaw = obj['components'];
  const wiresRaw = obj['wires'];
  if (!Array.isArray(componentsRaw) || !Array.isArray(wiresRaw)) {
    return { ok: false, error: '缺少 components/wires 数组' };
  }
  const components = [];
  const seenIds = new Set<string>();
  for (const c of componentsRaw) {
    if (!isObj(c)) return { ok: false, error: 'components 元素必须是对象' };
    const id = c['id'];
    const kind = c['kind'];
    const pos = c['pos'];
    const props = c['props'];
    if (typeof id !== 'string' || id.length === 0) return { ok: false, error: '组件 id 非法' };
    if (typeof kind !== 'string') return { ok: false, error: `组件 ${id} 的 kind 非法` };
    if (!isObj(pos) || typeof pos['x'] !== 'number' || typeof pos['y'] !== 'number') {
      return { ok: false, error: `组件 ${id} 的 pos 非法` };
    }
    if (!Number.isFinite(pos['x'] as number) || !Number.isFinite(pos['y'] as number)) {
      return { ok: false, error: `组件 ${id} 的 pos 含非有限数值` };
    }
    if (props !== undefined && !isObj(props)) return { ok: false, error: `组件 ${id} 的 props 非法` };
    if (seenIds.has(id)) return { ok: false, error: `组件 id 重复：${id}` };
    seenIds.add(id);
    const checkedProps: Record<string, number | string> = {};
    if (isObj(props)) {
      for (const [k, v] of Object.entries(props)) {
        if (typeof v !== 'number' && typeof v !== 'string') {
          return { ok: false, error: `组件 ${id} 的属性 ${k} 必须是 number/string` };
        }
        checkedProps[k] = v;
      }
    }
    components.push({ id, kind, pos: { x: pos['x'] as number, y: pos['y'] as number }, props: checkedProps });
  }
  const wires = [];
  const seenWireIds = new Set<string>();
  for (const w of wiresRaw) {
    if (!isObj(w)) return { ok: false, error: 'wires 元素必须是对象' };
    const id = w['id'];
    if (typeof id !== 'string' || id.length === 0) return { ok: false, error: '连线 id 非法' };
    if (seenWireIds.has(id)) return { ok: false, error: `连线 id 重复：${id}` };
    seenWireIds.add(id);
    const from = w['from'];
    const to = w['to'];
    for (const [name, ref] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (!isObj(ref) || typeof ref['componentId'] !== 'string' || typeof ref['port'] !== 'string') {
        return { ok: false, error: `连线 ${id} 的 ${name} 引用非法` };
      }
    }
    wires.push({
      id,
      from: { componentId: (from as Record<string, unknown>)['componentId'] as string, port: (from as Record<string, unknown>)['port'] as string },
      to: { componentId: (to as Record<string, unknown>)['componentId'] as string, port: (to as Record<string, unknown>)['port'] as string },
    });
  }
  return { ok: true, netlist: { components, wires } };
}

/** round-trip 校验工具（测试/保存前自检） */
export function roundTripEqual(nl: Netlist): boolean {
  const back = parseNetlist(serializeNetlist(nl));
  return back.ok && JSON.stringify(back.netlist) === JSON.stringify(nl);
}
