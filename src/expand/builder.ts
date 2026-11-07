/**
 * 网表构建器：以"端口引用"为中心的链式装配工具。
 *
 * 用法：
 *   const b = new NetlistBuilder();
 *   const a = b.add('n1', 'NOT');
 *   const y = b.pinIn('p1', 'enable');
 *   b.connect(y, a.port('a'));
 *   const netlist = b.build();
 *
 * 组件 id 由 add() 自动分配（kind 小写 + 序号），也可显式指定——
 * 需要稳定 id（如 'cpu'、'rom'）的组件务必显式命名，便于引擎 setInput/read 定位。
 */

import type { ComponentInstance, Netlist, PortRef } from '../contract';

export class NetlistBuilder {
  private components: ComponentInstance[] = [];
  private wires: Netlist['wires'] = [];
  private seq = 0;
  private ids = new Set<string>();
  private wireSeq = 0;

  /** 添加组件（kind 必须是引擎原语或已注册的库芯片），返回可连线的句柄 */
  add(id: string | undefined, kind: string, props: Record<string, number | string> = {}): CompHandle {
    const finalId = id ?? `${kind.toLowerCase()}_${this.seq++}`;
    if (this.ids.has(finalId)) throw new Error(`NetlistBuilder：组件 id 重复 "${finalId}"`);
    this.ids.add(finalId);
    this.components.push({
      id: finalId,
      kind,
      pos: { x: (this.components.length % 8) * 120, y: Math.floor(this.components.length / 8) * 100 },
      props,
    });
    return { componentId: finalId, ports: new Map() };
  }

  /** 根层对外输入（PIN_IN，name = 对外端口名） */
  pinIn(id: string, name: string, width = 1): PortRef {
    const h = this.add(id, 'PIN_IN', { name, width });
    return { componentId: h.componentId, port: 'y' };
  }

  /** 根层对外观察（PIN_OUT，name = 对外端口名） */
  pinOut(id: string, name: string): PortRef {
    const h = this.add(id, 'PIN_OUT', { name });
    return { componentId: h.componentId, port: 'a' };
  }

  /** 连线：from 与 to 都是 PortRef */
  connect(from: PortRef, to: PortRef): void {
    this.wires.push({ id: `w${this.wireSeq++}`, from, to });
  }

  build(): Netlist {
    return { components: this.components.map((c) => ({ ...c, pos: { ...c.pos }, props: { ...c.props } })), wires: this.wires.map((w) => ({ ...w })) };
  }
}

/** 组件句柄：port(name) 取得该组件某端口的引用（按需惰性填充端口名） */
export interface CompHandle {
  componentId: string;
  ports: Map<string, PortRef>;
}

/** 取组件句柄某端口的 PortRef */
export function port(h: CompHandle, name: string): PortRef {
  let p = h.ports.get(name);
  if (!p) {
    p = { componentId: h.componentId, port: name };
    h.ports.set(name, p);
  }
  return p;
}
