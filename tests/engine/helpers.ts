/**
 * 测试助手：极简网表构造 DSL。
 */

import type { ComponentInstance, Netlist, Wire } from '../../src/contract';

export function comp(
  id: string,
  kind: string,
  props: Record<string, number | string> = {},
): ComponentInstance {
  return { id, kind, pos: { x: 0, y: 0 }, props };
}

export interface Endpoint {
  c: string;
  p: string;
}

/** connect 同时接受紧凑端点 {c,p} 与契约 PortRef {componentId,port} */
export type AnyEndpoint = Endpoint | { componentId: string; port: string };

function norm(x: AnyEndpoint): { componentId: string; port: string } {
  return 'componentId' in x ? { componentId: x.componentId, port: x.port } : { componentId: x.c, port: x.p };
}

export function wire(id: string, from: AnyEndpoint, to: AnyEndpoint): Wire {
  return { id, from: norm(from), to: norm(to) };
}

export class NetlistBuilder {
  private components: ComponentInstance[] = [];
  private wires: Wire[] = [];
  private wireSeq = 0;

  add(id: string, kind: string, props: Record<string, number | string> = {}): this {
    this.components.push(comp(id, kind, props));
    return this;
  }

  /** 连线：id 自动生成 */
  connect(from: AnyEndpoint, to: AnyEndpoint, id?: string): this {
    this.wires.push(wire(id ?? `w${this.wireSeq++}`, from, to));
    return this;
  }

  build(): Netlist {
    return { components: [...this.components], wires: [...this.wires] };
  }
}

export const ref = (c: string, p: string) => ({ componentId: c, port: p });
