/**
 * 分层渲染器（M2）
 *
 * 绘制顺序：
 *   1. 背景与网格
 *   2. 连线（含拐点装饰、诊断着色）
 *   3. 组件体
 *   4. 端口与状态点
 *   5. 诊断高亮罩
 *   6. 选择框 / 幽灵预览 / 布线预览 / 框选矩形
 *
 * 所有坐标在 JS 侧经视图变换换算为屏幕坐标后绘制；
 * 渲染器只依赖 RenderContext 接口，可被 RecorderContext 无 DOM 测试。
 */

import type { Pos } from '../contract.js';
import type { RenderContext } from './RenderContext.js';
import type { Scene } from './scene.js';
import { COLORS, valueColor } from './colors.js';
import { drawComponentBodyAt } from './shapesDraw.js';
import { componentBoundsOf, getShape, portPos } from '../model/shapes.js';
import { allWirePolylines, portKey } from '../geometry/wirepath.js';
import { GRID } from '../geometry/grid.js';
import { worldToScreen } from '../geometry/view.js';
import { normalizeRect } from '../geometry/types.js';

const FONT = '10px sans-serif';

/** w2s：视图内联换算 */
function w2s(p: Pos, scene: Scene): Pos {
  return worldToScreen(p, scene.view.pan, scene.view.zoom);
}

/** 1. 背景与网格 */
export function drawGrid(rc: RenderContext, scene: Scene): void {
  const { width, height, pan, zoom } = scene.view;
  rc.setFillStyle(COLORS.background);
  rc.fillRect(0, 0, width, height);

  const minorPx = GRID * zoom;
  // 视口覆盖的世界范围
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
  // 主网格线（每 5 格）
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

/** 2. 连线层 */
export function drawWires(rc: RenderContext, scene: Scene): void {
  const polylines = allWirePolylines(scene.netlist, scene.bends);
  rc.setLineWidth(2);
  for (const wire of scene.netlist.wires) {
    const pts = polylines.get(wire.id) ?? [];
    if (pts.length < 2) continue;
    const selected = scene.selection.wires.has(wire.id);
    let color: string = COLORS.bodyStroke;
    if (scene.diags.conflictWireIds.has(wire.id)) color = COLORS.conflict;
    else if (scene.diags.floatingWireIds.has(wire.id)) color = COLORS.floating;
    else {
      const v = scene.values.get(portKey(wire.from.componentId, wire.from.port));
      if (v !== undefined) color = valueColor(v);
    }
    if (selected) color = COLORS.wireSelected;
    rc.setStrokeStyle(color);
    rc.beginPath();
    const first = w2s(pts[0]!, scene);
    rc.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const s = w2s(pts[i]!, scene);
      rc.lineTo(s.x, s.y);
    }
    rc.stroke();
    // 拐点小方点
    if (pts.length > 2) {
      rc.setFillStyle(color);
      for (let i = 1; i + 1 < pts.length; i++) {
        const s = w2s(pts[i]!, scene);
        rc.fillRect(s.x - 2, s.y - 2, 4, 4);
      }
    }
  }
}

/** 3+4. 组件体、端口与状态点（组件体在屏幕坐标绘制，随视图缩放） */
export function drawComponents(rc: RenderContext, scene: Scene): void {
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

function drawPorts(rc: RenderContext, scene: Scene): void {
  const r = 3;
  for (const comp of scene.netlist.components) {
    const def = getShape(comp.kind);
    for (const p of def.ports) {
      const world = portPos(comp, p.name);
      if (!world) continue;
      const s = w2s(world, scene);
      rc.beginPath();
      rc.arc(s.x, s.y, r, 0, Math.PI * 2, false);
      rc.setFillStyle(p.dir === 'in' ? COLORS.portIn : COLORS.portOut);
      rc.fill();
      // 输出端口附状态点（值着色）
      if (p.dir === 'out') {
        const v = scene.values.get(portKey(comp.id, p.name));
        if (v !== undefined) {
          rc.beginPath();
          rc.arc(s.x, s.y, 1.6, 0, Math.PI * 2, false);
          rc.setFillStyle(valueColor(v));
          rc.fill();
        }
      }
    }
  }
}

/** 5. 诊断高亮（floating 灰、conflict 红、oscillation 闪） */
export function drawDiagnostics(rc: RenderContext, scene: Scene): void {
  const z = scene.view.zoom;
  // 振荡是全局状态：对时序组件（DFF/CLK）闪烁警示；诊断若点名组件则精确高亮
  const blinkOn = Math.floor(scene.time / 420) % 2 === 1;
  for (const comp of scene.netlist.components) {
    let isError = scene.diags.errorComponentIds.has(comp.id);
    let isWarn = scene.diags.warnComponentIds.has(comp.id);
    if (!isError && !isWarn && scene.diags.oscillating && (comp.kind === 'DFF' || comp.kind === 'CLK')) {
      isWarn = true;
    }
    if (!isError && !isWarn) continue;
    if (isWarn && scene.diags.oscillating && !blinkOn) continue; // 闪烁 off 相位
    const b = componentBoundsOf(comp);
    const a = w2s(b, scene);
    rc.setFillStyle(isError ? COLORS.diagErrorFill : COLORS.diagWarnFill);
    rc.fillRect(a.x, a.y, b.w * z, b.h * z);
  }
}

/** 6. 覆盖层：幽灵/布线预览/框选 */
export function drawOverlay(rc: RenderContext, scene: Scene): void {
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
    const first = w2s(o.wirePreview[0]!, scene);
    rc.moveTo(first.x, first.y);
    for (let i = 1; i < o.wirePreview.length; i++) {
      const s = w2s(o.wirePreview[i]!, scene);
      rc.lineTo(s.x, s.y);
    }
    rc.stroke();
    rc.setLineDash([]);
  }
  if (o.ghost) {
    const fake = { id: '__ghost__', kind: o.ghost.kind, pos: o.ghost.pos, props: {} };
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

/** 一帧完整绘制 */
export function drawScene(rc: RenderContext, scene: Scene): void {
  drawGrid(rc, scene);
  drawWires(rc, scene);
  drawComponents(rc, scene);
  drawDiagnostics(rc, scene);
  drawOverlay(rc, scene);
}
