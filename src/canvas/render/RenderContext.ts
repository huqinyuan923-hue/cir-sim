/**
 * RenderContext —— 渲染器唯一依赖的绘制接口（M2 关键设计）
 *
 * 封装 2D context 的绘制原语。渲染器只面向本接口编程：
 * - 生产环境：CanvasAdapter 包装真实 CanvasRenderingContext2D；
 * - 测试环境：RecorderContext 录制调用序列做快照断言，无需真实 DOM。
 */

export interface TextMetrics {
  width: number;
}

export interface RenderContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): TextMetrics;
  setStrokeStyle(style: string): void;
  setFillStyle(style: string): void;
  setLineWidth(width: number): void;
  setFont(font: string): void;
  setLineDash(dash: readonly number[]): void;
}
