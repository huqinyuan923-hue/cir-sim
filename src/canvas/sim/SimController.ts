/**
 * SimController —— 仿真控制（M5 控制条的后端）
 * 包装 SimEngine：网表同步、值表缓存、run 定时循环（tick+edge，60Hz 基准可调速）。
 * 引擎本身可替换（MockEngine 或第三部真实引擎）。
 */

import type { Diagnostic, Netlist, PortRef } from '../contract.js';
import type { ValueTable } from '../render/scene.js';
import { portKey } from '../geometry/wirepath.js';
import { getShape } from '../model/shapes.js';
import type { SimEngine, TickResult } from '../contract.js';

export const RUN_BASE_HZ = 60;

export type SpeedFactor = 0.5 | 1 | 2 | 4;

export class SimController {
  values: ValueTable = new Map();
  lastTick: TickResult | null = null;
  running = false;

  private timer: ReturnType<typeof setInterval> | null = null;
  private speed: SpeedFactor = 1;
  private readonly listeners = new Set<() => void>();
  /** 诊断缓存（值刷新时同步更新，渲染每帧读缓存而非重算引擎） */
  private diagCache: Diagnostic[] = [];
  private netlistRef: Netlist = { components: [], wires: [] };

  constructor(readonly engine: SimEngine) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** 网表变更后同步引擎（重新 load） */
  syncNetlist(nl: Netlist): void {
    this.netlistRef = nl;
    this.engine.load(nl);
    this.refreshValues();
  }

  /** 刷新全端口值表与诊断缓存（渲染用） */
  refreshValues(): void {
    const map = new Map<string, number>();
    for (const comp of this.netlistRef.components) {
      for (const p of getShape(comp.kind).ports) {
        map.set(portKey(comp.id, p.name), this.engine.read({ componentId: comp.id, port: p.name }));
      }
    }
    this.values = map;
    this.diagCache = this.engine.diagnostics();
    this.emit();
  }

  /** 注入网表引用（渲染侧值表来源；也可由 syncNetlist 隐式调用） */
  setNetlistRef(nl: Netlist): void {
    this.netlistRef = nl;
  }

  tick(maxSteps?: number): TickResult {
    this.lastTick = this.engine.tick(maxSteps);
    this.refreshValues();
    return this.lastTick;
  }

  clockEdge(): void {
    this.engine.clockEdge();
    this.refreshValues();
  }

  reset(): void {
    this.engine.reset();
    this.refreshValues();
  }

  setInput(port: PortRef, value: number): void {
    this.engine.setInput(port, value);
    this.refreshValues();
  }

  /** 翻转 INPUT 组件（返回翻转后的值） */
  toggleInput(componentId: string): number {
    const cur = this.engine.read({ componentId, port: 'OUT' });
    const next = cur === 1 ? 0 : 1;
    this.engine.setInput({ componentId, port: 'OUT' }, next);
    this.refreshValues();
    return next;
  }

  /* ------------------------------ run 循环 ------------------------------ */

  /** 单次运行迭代：组合传播 + 时钟沿（60Hz 每帧调用一次） */
  step(): void {
    this.tick();
    this.clockEdge();
  }

  run(): void {
    if (this.running) return;
    this.running = true;
    const interval = Math.max(4, Math.round(1000 / (RUN_BASE_HZ * this.speed)));
    this.timer = setInterval(() => this.step(), interval);
    this.emit();
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit();
  }

  setSpeed(s: SpeedFactor): void {
    this.speed = s;
    if (this.running) {
      this.pause();
      this.run();
    }
    this.emit();
  }

  getSpeed(): SpeedFactor {
    return this.speed;
  }

  diagnostics(): Diagnostic[] {
    return this.diagCache;
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }
}
