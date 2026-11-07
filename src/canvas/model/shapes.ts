/**
 * 组件形状注册表（几何元数据）
 *
 * 画布侧的组件外观/端口定义。契约只规定 kind 为字符串，这里给出
 * 常见原语的默认形状；未知 kind 回退为通用虚线盒（无端口），
 * 仿真侧会以 unknown-kind 诊断提示。
 *
 * 注意：这是画布侧注册表，不是契约的一部分；第三部接入真实引擎时
 * 可通过 registerShape 对齐引擎的芯片库。
 */

import type { ComponentInstance, Pos } from '../contract.js';
import type { Dir, Rect } from '../geometry/types.js';
import { GRID } from '../geometry/grid.js';

/** 端口在组件上的方位（决定连线引出段方向） */
export type PortSide = 'left' | 'right' | 'top' | 'bottom';

export interface ShapePort {
  /** 端口名（对应契约 PortRef.port） */
  name: string;
  dir: 'in' | 'out';
  side: PortSide;
  /** 相对组件左上角的偏移（格单位，整数 → 端口恒在网格上） */
  ux: number;
  uy: number;
}

export interface ShapeDef {
  kind: string;
  label: string;
  /** 宽/高（格单位） */
  w: number;
  h: number;
  ports: readonly ShapePort[];
}

/** 引出段方向：由端口方位决定（背离组件体） */
export function sideToDir(side: PortSide): Dir {
  switch (side) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'top':
      return 'up';
    case 'bottom':
      return 'down';
  }
}

const gatePorts: readonly ShapePort[] = [
  { name: 'A', dir: 'in', side: 'left', ux: 0, uy: 1 },
  { name: 'B', dir: 'in', side: 'left', ux: 0, uy: 3 },
  { name: 'OUT', dir: 'out', side: 'right', ux: 3, uy: 2 },
];

/** 内置形状表（保持定义顺序即工具栏顺序） */
export const DEFAULT_SHAPES: readonly ShapeDef[] = [
  { kind: 'INPUT', label: '输入', w: 2, h: 2, ports: [{ name: 'OUT', dir: 'out', side: 'right', ux: 2, uy: 1 }] },
  { kind: 'OUTPUT', label: '输出', w: 2, h: 2, ports: [{ name: 'IN', dir: 'in', side: 'left', ux: 0, uy: 1 }] },
  { kind: 'AND', label: 'AND', w: 3, h: 4, ports: gatePorts },
  { kind: 'OR', label: 'OR', w: 3, h: 4, ports: gatePorts },
  { kind: 'XOR', label: 'XOR', w: 3, h: 4, ports: gatePorts },
  {
    kind: 'NOT',
    label: 'NOT',
    w: 3,
    h: 4,
    ports: [
      { name: 'A', dir: 'in', side: 'left', ux: 0, uy: 2 },
      { name: 'OUT', dir: 'out', side: 'right', ux: 3, uy: 2 },
    ],
  },
  {
    kind: 'DFF',
    label: 'DFF',
    w: 3,
    h: 4,
    ports: [
      { name: 'D', dir: 'in', side: 'left', ux: 0, uy: 1 },
      { name: 'CLK', dir: 'in', side: 'left', ux: 0, uy: 3 },
      { name: 'Q', dir: 'out', side: 'right', ux: 3, uy: 2 },
    ],
  },
  { kind: 'CLK', label: '时钟', w: 2, h: 4, ports: [{ name: 'OUT', dir: 'out', side: 'right', ux: 2, uy: 2 }] },
];

const registry = new Map<string, ShapeDef>();
for (const def of DEFAULT_SHAPES) registry.set(def.kind, def);

/** 注册/覆盖形状 */
export function registerShape(def: ShapeDef): void {
  registry.set(def.kind, def);
}

/** 未知 kind 的通用回退形状（虚线盒，无端口） */
export function genericShape(kind: string): ShapeDef {
  return { kind, label: kind, w: 2, h: 2, ports: [] };
}

/** 查形状：注册表优先，未注册回退通用盒 */
export function getShape(kind: string): ShapeDef {
  return registry.get(kind) ?? genericShape(kind);
}

/** 已注册 kind 列表（工具栏用） */
export function listShapeKinds(): string[] {
  return [...registry.keys()];
}

/** 组件世界像素尺寸 */
export function componentPixelSize(kind: string): { w: number; h: number } {
  const def = getShape(kind);
  return { w: def.w * GRID, h: def.h * GRID };
}

/** 组件包围盒（世界坐标） */
export function componentBoundsOf(comp: ComponentInstance): Rect {
  const s = componentPixelSize(comp.kind);
  return { x: comp.pos.x, y: comp.pos.y, w: s.w, h: s.h };
}

/** 端口世界坐标（组件 pos + 偏移 * GRID） */
export function portPos(comp: ComponentInstance, portName: string): Pos | null {
  const def = getShape(comp.kind);
  const p = def.ports.find((pt) => pt.name === portName);
  if (!p) return null;
  return { x: comp.pos.x + p.ux * GRID, y: comp.pos.y + p.uy * GRID };
}

/** 组件全部端口及其世界坐标 */
export function portsOf(comp: ComponentInstance): readonly { port: ShapePort; pos: Pos }[] {
  const def = getShape(comp.kind);
  return def.ports.map((p) => ({
    port: p,
    pos: { x: comp.pos.x + p.ux * GRID, y: comp.pos.y + p.uy * GRID },
  }));
}

/** 端口引出段方向（连线从该端口出发时的初始走向） */
export function portStubDir(kind: string, portName: string): Dir | null {
  const def = getShape(kind);
  const p = def.ports.find((pt) => pt.name === portName);
  return p ? sideToDir(p.side) : null;
}
