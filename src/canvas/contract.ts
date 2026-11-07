/**
 * 电路仿真器 · 共享契约 v1.0（冻结文件）
 * 三部共同遵守，禁止修改。缺陷一律写 README-偏差记录.md。
 * 语义注释见第一部任务书附录。
 */

export interface Pos {
  x: number;
  y: number;
}

export interface ComponentInstance {
  id: string;
  kind: string;
  pos: Pos;
  props: Record<string, number | string>;
}

export interface PortRef {
  componentId: string;
  port: string;
}

export interface Wire {
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface Netlist {
  components: ComponentInstance[];
  wires: Wire[];
}

export interface TickResult {
  stable: boolean;
  steps: number;
  oscillated: boolean;
}

export interface Diagnostic {
  level: 'error' | 'warning';
  kind: 'floating' | 'conflict' | 'oscillation' | 'unknown-kind';
  message: string;
  componentIds?: string[];
  wireIds?: string[];
}

export interface ChipPort {
  name: string;
  dir: 'in' | 'out';
  width: number;
}

export type BehaviorState = Record<string, unknown>;

/** 芯片行为：组合逻辑用 evaluate；时序在 state 里存值，onClockEdge 里采样 */
export interface ChipBehavior {
  ports: ChipPort[];
  initState?(
    props: Readonly<Record<string, number | string>>,
  ): BehaviorState;
  evaluate(
    inputs: Readonly<Record<string, number>>,
    state: BehaviorState,
    props: Readonly<Record<string, number | string>>,
  ): Record<string, number>;
  onClockEdge?(
    inputs: Readonly<Record<string, number>>,
    state: BehaviorState,
    props: Readonly<Record<string, number | string>>,
  ): void;
}

export interface SimEngine {
  load(netlist: Netlist): void;
  reset(): void;
  setInput(port: PortRef, value: number): void;
  read(port: PortRef): number;
  /** 组合传播直到稳定（或 oscillated） */
  tick(maxSteps?: number): TickResult;
  /** 时钟上升沿：所有 DFF 采样其 D 输入 */
  clockEdge(): void;
  /** 注册/覆盖芯片行为（原语内置，库芯片用此注册） */
  registerBehavior(kind: string, behavior: ChipBehavior): void;
  diagnostics(): Diagnostic[];
}
