/**
 * 各 kind 的组件体绘制（画布侧像素级外观）
 * 只负责"画组件体"，端口/选择框/诊断高亮由 renderer 统一处理。
 */

import type { ComponentInstance } from '../contract.js';
import type { RenderContext } from './RenderContext.js';
import { COLORS } from './colors.js';
import { getShape, componentPixelSize } from '../model/shapes.js';

/** 网格像素 */
const G = 20;

type Painter = (rc: RenderContext, x: number, y: number, w: number, h: number, comp: ComponentInstance) => void;

/** 通用矩形盒（未知 kind 回退：虚线边框 + kind 标签） */
function paintGeneric(rc: RenderContext, x: number, y: number, w: number, h: number, comp: ComponentInstance): void {
  rc.setFillStyle(COLORS.body);
  rc.fillRect(x, y, w, h);
  rc.setStrokeStyle(COLORS.bodyStroke);
  rc.setLineWidth(1.5);
  rc.setLineDash([4, 3]);
  rc.strokeRect(x, y, w, h);
  rc.setLineDash([]);
  rc.setFillStyle(COLORS.label);
  rc.setFont('10px sans-serif');
  rc.fillText(getShape(comp.kind).label, x + 6, y + h / 2 + 3);
}

function paintRectGate(label: string, innerArc: boolean): Painter {
  return (rc, x, y, w, h) => {
    rc.setFillStyle(COLORS.body);
    rc.fillRect(x, y, w, h);
    // 右侧半圆（D 形）
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
    rc.setFont('10px sans-serif');
    rc.fillText(label, x + 6, y + h / 2 + 3);
    if (innerArc) {
      // OR/XOR 的左弧提示线
      rc.beginPath();
      rc.moveTo(x + 4, y);
      rc.lineTo(x + 4, y + h);
      rc.setStrokeStyle('rgba(55,71,79,0.35)');
      rc.setLineWidth(1);
      rc.stroke();
    }
  };
}

function paintNot(rc: RenderContext, x: number, y: number, w: number, h: number): void {
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
  // 输出小圆圈
  rc.beginPath();
  rc.arc(x + w + 4, y + h / 2, 4, 0, Math.PI * 2, false);
  rc.stroke();
  rc.setFillStyle(COLORS.label);
  rc.setFont('10px sans-serif');
  rc.fillText('1', x + 6, y + h / 2 + 3);
}

function paintInput(rc: RenderContext, x: number, y: number, w: number, h: number, comp: ComponentInstance): void {
  rc.setFillStyle('#e8f5e9');
  rc.fillRect(x, y, w, h);
  rc.setStrokeStyle(COLORS.bodyStroke);
  rc.setLineWidth(1.5);
  rc.strokeRect(x, y, w, h);
  rc.setFillStyle(COLORS.label);
  rc.setFont('10px sans-serif');
  rc.fillText(getShape(comp.kind).label, x + 4, y + h / 2 + 3);
}

function paintClk(rc: RenderContext, x: number, y: number, w: number, h: number): void {
  rc.setFillStyle('#fff8e1');
  rc.fillRect(x, y, w, h);
  rc.setStrokeStyle(COLORS.bodyStroke);
  rc.setLineWidth(1.5);
  rc.strokeRect(x, y, w, h);
  // 方波符号
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
  rc.setFont('9px sans-serif');
  rc.fillText('CLK', x + 4, y + h + 10);
}

const painters = new Map<string, Painter>([
  ['AND', paintRectGate('AND', false)],
  ['OR', paintRectGate('OR', true)],
  ['XOR', paintRectGate('XOR', true)],
]);

/** 画一个组件体（体 + 标签）。坐标为屏幕坐标（由调用方完成视图变换）。 */
export function drawComponentBodyAt(
  rc: RenderContext,
  comp: ComponentInstance,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (comp.kind === 'INPUT') return paintInput(rc, x, y, w, h, comp);
  if (comp.kind === 'OUTPUT') return paintInput(rc, x, y, w, h, comp);
  if (comp.kind === 'NOT') return paintNot(rc, x, y, w, h);
  if (comp.kind === 'CLK') return paintClk(rc, x, y, w, h);
  if (comp.kind === 'DFF') {
    paintRectGate('DFF', false)(rc, x, y, w, h, comp);
    return;
  }
  const painter = painters.get(comp.kind);
  if (painter) {
    painter(rc, x, y, w, h, comp);
    return;
  }
  paintGeneric(rc, x, y, w, h, comp);
}
