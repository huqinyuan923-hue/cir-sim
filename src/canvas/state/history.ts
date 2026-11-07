/**
 * 编辑历史（undo/redo 栈，M4）
 * 通用快照栈：undo = 弹出上一个快照；redo = 弹出下一个快照。
 * 快照为不可变 Netlist 引用（编辑函数均返回新对象，天然共享结构）。
 */

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];

  constructor(private readonly limit: number = 100) {}

  /** 在"应用新状态前"调用：把当前状态存入撤销栈，并作废重做栈 */
  push(current: T): void {
    this.undoStack.push(current);
    if (this.undoStack.length > this.limit) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** 撤销：current 进重做栈，弹出并返回上一个状态（不可撤销返回 null） */
  undo(current: T): T | null {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(current);
    return prev;
  }

  /** 重做：current 进撤销栈，弹出并返回下一个状态（不可重做返回 null） */
  redo(current: T): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 撤销栈深度（测试观测） */
  get depth(): number {
    return this.undoStack.length;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
