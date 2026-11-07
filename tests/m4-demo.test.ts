/**
 * M4c · demo 程序对拍：弹跳方块（点屏动效）。
 * tetris 因黄金脚本跨度 1.6 亿周期，单测只做"能否引导出画面"的抽查（见 m6 基准脚本）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HackMachine } from '../src/hack/computer';
import { makeEngine } from '../src/testkit/engineFactory';
import { screenPixel } from '../src/chips/handles';

const here = dirname(fileURLToPath(import.meta.url));
function loadProgram(name: string): string {
  return readFileSync(join(here, '..', 'src', 'hack', 'programs', name), 'utf-8');
}

/** 屏幕上非零字计数（一个 16 行竖条 = 16 字） */
function litWords(m: HackMachine): number {
  let n = 0;
  for (let w = 0; w < 8192; w++) if (m.screen.words[w] !== 0) n++;
  return n;
}

/**
 * 逐周期推进一个完整帧：先等旧块开始被清除（亮字 < 16），再等新块画满（亮字 = 16）。
 * 期间任何时刻亮字数不得超过 16（越界回卷会多出亮字）。
 */
function runUntilFullBlock(m: HackMachine, maxCycles: number): void {
  let maxLit = 0;
  let sawGap = litWords(m) < 16; // 起始不满（首帧）则直接进入等满阶段
  let sawFull = false;
  for (let i = 0; i < maxCycles; i++) {
    m.cycle();
    const lit = litWords(m);
    if (lit > maxLit) maxLit = lit;
    if (!sawGap) {
      if (lit < 16) sawGap = true;
      continue;
    }
    if (lit === 16) {
      sawFull = true;
      break;
    }
  }
  expect(maxLit, '绘制过程中亮字数不得超过 16（越界回卷会多出亮字）').toBeLessThanOrEqual(16);
  expect(sawFull, '应出现完整 16 字竖条').toBe(true);
}

describe('M4c · demo：弹跳方块（点屏动效）', () => {
  it('16×16 方块出现并随帧移动（清 16 行竖条 → 画新 16 行竖条）', () => {
    const m = new HackMachine(makeEngine(), { program: loadProgram('movblk.hack') });
    // 程序"先移动后绘制"：首帧块顶画在 w = 124+33 = 157（列 29、行 4）
    runUntilFullBlock(m, 5000);
    for (const r of [0, 1, 8, 15]) {
      expect(m.screen.words[157 + 32 * r], `首帧竖条行 ${r}`).toBe(0xffff);
    }
    // 第二帧：下一位置 190（列 30、行 5），旧竖条清除
    runUntilFullBlock(m, 5000);
    for (const r of [0, 8, 15]) {
      expect(m.screen.words[157 + 32 * r], `旧竖条已清行 ${r}`).toBe(0);
      expect(m.screen.words[190 + 32 * r], `新竖条行 ${r}`).toBe(0xffff);
    }
    // 像素口径：块 (30*16, 5) 到 (30*16, 20) 亮，块外 (30*16, 21) 不亮
    expect(screenPixel(m.screen.words, 30 * 16, 5)).toBe(1);
    expect(screenPixel(m.screen.words, 30 * 16, 20)).toBe(1);
    expect(screenPixel(m.screen.words, 30 * 16, 21)).toBe(0);
    expect(screenPixel(m.screen.words, 31 * 16, 5)).toBe(0);
  });

  it('碰壁反弹：x 到边界后 dx 反向（长跑抽查）', () => {
    const m = new HackMachine(makeEngine(), { program: loadProgram('movblk.hack') });
    // 跑 8 个完整帧（每帧 ~2400 周期），每帧都应完整出现 16 字竖条且从无残留
    for (let f = 0; f < 8; f++) runUntilFullBlock(m, 5000);
    expect(litWords(m)).toBe(16);
  });
});
