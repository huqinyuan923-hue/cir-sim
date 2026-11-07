/**
 * 芯片库统一注册入口。
 *
 * registerChipLibrary(engine) 把本部全部库芯片按 kind 名注册进引擎
 * （与引擎内置原语同一机制，契约 registerBehavior）。kind 名即网表里的
 * ComponentInstance.kind，全部大写，与 nand-computer 术语对齐。
 */

import type { SimEngine } from '../contract';
import { combinationalChips } from './bits';
import { ALU_BEHAVIOR } from './alu';
import { sequentialChips } from './seq';
import { memoryChips } from './memory';
import { peripheralChips } from './io';
import { MEMDECODE_BEHAVIOR } from './memdecode';

/** 芯片库完整清单：kind → 行为（只读快照，供展开器校验/文档生成） */
export function chipLibrary(): Record<string, import('../contract').ChipBehavior> {
  return {
    ...combinationalChips(),
    ALU: ALU_BEHAVIOR,
    ...sequentialChips(),
    ...memoryChips(),
    ...peripheralChips(),
    MEMDECODE: MEMDECODE_BEHAVIOR,
  };
}

/** 把芯片库注册进引擎（重复注册 = 覆盖，幂等） */
export function registerChipLibrary(engine: SimEngine): void {
  for (const [kind, behavior] of Object.entries(chipLibrary())) {
    engine.registerBehavior(kind, behavior);
  }
}
