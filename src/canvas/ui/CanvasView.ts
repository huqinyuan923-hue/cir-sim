/**
 * CanvasView —— 画布元素与视图变换的所有者
 * 负责：DPR 适配、尺寸跟踪、pan/zoom 状态、指针/滚轮事件归一化为世界坐标后回调。
 * 平移（空格拖拽 / 中键拖拽）由本类自持，不进入交互状态机。
 */

import type { Pos } from '../contract.js';
import { clampZoom, screenToWorld, panForZoomAt } from '../geometry/view.js';

export interface PointerEventInfo {
  world: Pos;
  screen: Pos;
  button: 0 | 1 | 2;
  shift: boolean;
  ctrl: boolean;
}

export interface CanvasViewCallbacks {
  onPointerDown(e: PointerEventInfo): void;
  onPointerMove(e: PointerEventInfo): void;
  onPointerUp(e: PointerEventInfo): void;
  onDoubleClick(e: PointerEventInfo): void;
  onWheel(scaleFactor: number, screenPos: Pos): void;
  onResize(width: number, height: number): void;
  onViewChanged(): void;
  /** 是否处于"平移模式"（空格按住）——由控制器提供 */
  isPanMode(): boolean;
}

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private cbs: CanvasViewCallbacks | null = null;
  width = 800;
  height = 600;
  pan: Pos = { x: 60, y: 40 };
  zoom = 1;
  private panning = false;
  private panLast: Pos = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** 绑定回调并初始化事件（构造后调用一次） */
  attach(cbs: CanvasViewCallbacks): void {
    if (this.ctx) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D context');
    this.ctx = ctx;
    this.cbs = cbs;
    this.bindEvents();
    this.resize();
  }

  /** DPR 适配：物理像素 = CSS 像素 × dpr，绘制坐标系仍为 CSS 像素 */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    if (this.ctx) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.cbs) this.cbs.onResize(this.width, this.height);
  }

  /** 供渲染取 2D context 的原生句柄（Controller 用 CanvasAdapter 包装） */
  get rawContext(): CanvasRenderingContext2D {
    if (!this.ctx) throw new Error('CanvasView 未 attach');
    return this.ctx;
  }

  screenToWorld(p: Pos): Pos {
    return screenToWorld(p, this.pan, this.zoom);
  }

  worldToScreen(p: Pos): Pos {
    const z = this.zoom;
    return { x: p.x * z + this.pan.x, y: p.y * z + this.pan.y };
  }

  /** 以屏幕点为锚缩放（锚点世界坐标保持不动） */
  zoomAt(screenPos: Pos, factor: number): void {
    const newZoom = clampZoom(this.zoom * factor);
    const world = this.screenToWorld(screenPos);
    this.zoom = newZoom;
    this.pan = panForZoomAt(screenPos, world, newZoom);
    if (this.cbs) this.cbs.onViewChanged();
  }

  setZoomAtCenter(zoom: number): void {
    const center = { x: this.width / 2, y: this.height / 2 };
    const newZoom = clampZoom(zoom);
    const world = this.screenToWorld(center);
    this.zoom = newZoom;
    this.pan = panForZoomAt(center, world, newZoom);
    if (this.cbs) this.cbs.onViewChanged();
  }

  private toInfo(e: MouseEvent): PointerEventInfo {
    const rect = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    return {
      screen,
      world: this.screenToWorld(screen),
      button: e.button as 0 | 1 | 2,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
    };
  }

  private bindEvents(): void {
    const cbs = (): CanvasViewCallbacks => {
      if (!this.cbs) throw new Error('CanvasView 未 attach');
      return this.cbs;
    };
    const c = this.canvas;
    c.addEventListener('mousedown', (e) => {
      if (e.button === 1 || (e.button === 0 && cbs().isPanMode())) {
        this.panning = true;
        this.panLast = { x: e.clientX, y: e.clientY };
        e.preventDefault();
        return;
      }
      cbs().onPointerDown(this.toInfo(e));
    });
    c.addEventListener('mousemove', (e) => {
      if (this.panning) {
        this.pan = {
          x: this.pan.x + (e.clientX - this.panLast.x),
          y: this.pan.y + (e.clientY - this.panLast.y),
        };
        this.panLast = { x: e.clientX, y: e.clientY };
        cbs().onViewChanged();
        return;
      }
      cbs().onPointerMove(this.toInfo(e));
    });
    window.addEventListener('mouseup', (e) => {
      if (this.panning) {
        this.panning = false;
        return;
      }
      cbs().onPointerUp(this.toInfo(e));
    });
    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      cbs().onDoubleClick(this.toInfo(e));
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        cbs().onWheel(factor, screen);
      },
      { passive: false },
    );
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    window.addEventListener('resize', () => this.resize());
  }
}
