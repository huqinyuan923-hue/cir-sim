/**
 * 公开入口：createEngine()。
 * 内置原语在此注册（与库芯片同一条 registerBehavior 通路——构造期直接写入行为表）。
 */

import type { ChipBehavior, SimEngine } from '../contract';
import { EngineImpl } from './EngineImpl';
import { PRIMITIVES } from './primitives';

export function createEngine(): SimEngine {
  const initial: [string, ChipBehavior][] = Object.entries(PRIMITIVES);
  return new EngineImpl(initial);
}
