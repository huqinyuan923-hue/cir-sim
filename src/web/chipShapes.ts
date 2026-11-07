/**
 * 芯片库 → 画布形状注册：为每个 kind 自动生成"标准盒"形状
 * （输入端口左侧排布、输出端口右侧排布），让画布按正确端口读值与绘制。
 * 端口名/方向/宽度直接来自引擎行为声明，画布与引擎永远一致。
 */

import type { ChipPort } from '../contract';
import { PRIMITIVES } from '../engine/primitives';
import { chipLibrary } from '../chips/registerAll';
import { registerShape, type ShapeDef, type ShapePort } from '../canvas/model/shapes';

/** 端口在盒边上的纵向铺排：单端口居中，多端口均匀分布 */
function spread(count: number, rows: number, i: number): number {
  if (count <= 1) return Math.floor(rows / 2);
  return Math.round((i * (rows - 1)) / (count - 1));
}

function shapeFor(kind: string, ports: readonly ChipPort[]): ShapeDef {
  const ins = ports.filter((pt) => pt.dir === 'in');
  const outs = ports.filter((pt) => pt.dir === 'out');
  const rows = Math.max(ins.length, outs.length, 2);
  const h = rows;
  // 宽度按名字长度收放（2..5 格），标签能放下即可
  const w = Math.min(5, Math.max(2, Math.ceil(kind.length / 3)));
  const shapePorts: ShapePort[] = [];
  ins.forEach((pt, i) => {
    shapePorts.push({ name: pt.name, dir: 'in', side: 'left', ux: 0, uy: spread(ins.length, rows, i) });
  });
  outs.forEach((pt, i) => {
    shapePorts.push({ name: pt.name, dir: 'out', side: 'right', ux: w, uy: spread(outs.length, rows, i) });
  });
  return { kind, label: kind, w, h, ports: shapePorts };
}

/** 注册芯片库 + 引擎原语的全部形状（幂等，重复注册 = 覆盖） */
export function registerChipShapes(): void {
  const all: Record<string, { ports: readonly ChipPort[] }> = {
    ...(PRIMITIVES as Record<string, { ports: readonly ChipPort[] }>),
    ...chipLibrary(),
  };
  for (const [kind, behavior] of Object.entries(all)) {
    registerShape(shapeFor(kind, behavior.ports));
  }
}
