/**
 * RecorderContext —— 测试录制桩
 * 记录每一次绘制调用（方法名 + 参数），供快照断言；不依赖 DOM。
 */

import type { RenderContext, TextMetrics } from './RenderContext.js';

export interface RecordedCall {
  op: string;
  args: unknown[];
}

export class RecorderContext implements RenderContext {
  readonly calls: RecordedCall[] = [];

  private record(op: string, args: unknown[]): void {
    this.calls.push({ op, args });
  }

  beginPath(): void {
    this.record('beginPath', []);
  }
  moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y]);
  }
  closePath(): void {
    this.record('closePath', []);
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void {
    this.record('arc', [x, y, radius, startAngle, endAngle, counterclockwise ?? false]);
  }
  stroke(): void {
    this.record('stroke', []);
  }
  fill(): void {
    this.record('fill', []);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record('fillRect', [x, y, w, h]);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record('strokeRect', [x, y, w, h]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.record('clearRect', [x, y, w, h]);
  }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', [text, x, y]);
  }
  measureText(text: string): TextMetrics {
    this.record('measureText', [text]);
    return { width: text.length * 6 }; // 伪宽度，确定性
  }
  setStrokeStyle(style: string): void {
    this.record('setStrokeStyle', [style]);
  }
  setFillStyle(style: string): void {
    this.record('setFillStyle', [style]);
  }
  setLineWidth(width: number): void {
    this.record('setLineWidth', [width]);
  }
  setFont(font: string): void {
    this.record('setFont', [font]);
  }
  setLineDash(dash: readonly number[]): void {
    this.record('setLineDash', [[...dash]]);
  }

  /** 全部调用序列的字符串快照（一行一调用），便于整段断言 */
  snapshot(): string[] {
    return this.calls.map((c) => `${c.op} ${c.args.map((a) => JSON.stringify(a)).join(' ')}`);
  }

  /** 按 op 过滤 */
  filter(op: string): RecordedCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** 某 op 的调用次数 */
  count(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /** 是否发生过某次调用（精确匹配参数） */
  has(op: string, args: unknown[]): boolean {
    return this.calls.some(
      (c) => c.op === op && c.args.length === args.length && c.args.every((a, i) => JSON.stringify(a) === JSON.stringify(args[i])),
    );
  }

  reset(): void {
    this.calls.length = 0;
  }
}
