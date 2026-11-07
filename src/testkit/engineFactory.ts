/**
 * 引擎工厂：测试统一从这里拿 SimEngine。
 *
 * M5 集成：真引擎（第一部交付，src/engine/，契约校验字节一致）已拷入。
 * 全部黄金向量测试在真引擎上原样通过（tests 全绿即验收）。
 * DevEngine（src/testkit/devEngine.ts）保留作为暴力参考实现，用于差分对拍。
 */

import type { SimEngine } from '../contract';
import { createEngine } from '../engine/createEngine';

export function makeEngine(): SimEngine {
  return createEngine();
}
