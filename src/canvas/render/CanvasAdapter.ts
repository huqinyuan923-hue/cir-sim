/**
 * CanvasAdapter —— 生产环境 RenderContext 实现
 * 直接委托浏览器 CanvasRenderingContext2D（标准 DOM API，非依赖）。
 */

import type { RenderContext, TextMetrics } from './RenderContext.js';

export class CanvasAdapter implements RenderContext {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  beginPath(): void {
    this.ctx.beginPath();
  }
  moveTo(x: number, y: number): void {
    this.ctx.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.ctx.lineTo(x, y);
  }
  closePath(): void {
    this.ctx.closePath();
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void {
    this.ctx.arc(x, y, radius, startAngle, endAngle, counterclockwise ?? false);
  }
  stroke(): void {
    this.ctx.stroke();
  }
  fill(): void {
    this.ctx.fill();
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ctx.fillRect(x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.ctx.strokeRect(x, y, w, h);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.ctx.clearRect(x, y, w, h);
  }
  fillText(text: string, x: number, y: number): void {
    this.ctx.fillText(text, x, y);
  }
  measureText(text: string): TextMetrics {
    return this.ctx.measureText(text);
  }
  setStrokeStyle(style: string): void {
    this.ctx.strokeStyle = style;
  }
  setFillStyle(style: string): void {
    this.ctx.fillStyle = style;
  }
  setLineWidth(width: number): void {
    this.ctx.lineWidth = width;
  }
  setFont(font: string): void {
    this.ctx.font = font;
  }
  setLineDash(dash: readonly number[]): void {
    this.ctx.setLineDash([...dash]);
  }
}
