/**
 * tetris 程序级差分对拍（可选长测，默认跳过）：
 *
 *   TETRIS_DIFF=1 npx vitest run tests/m6-tetris-diff.test.ts
 *
 * 用 nand-computer 官方行为核（software/demo/engine.js，只读引用）跑同样周期数，
 * 逐字节比对 RAM（0x0000-0x3FFF）与屏幕区（0x4000-0x5FFF）的 SHA-256。
 * 已验证：3M 与 12.3M 周期两处，RAM/SCREEN 哈希与官方核完全一致；
 * 12.3M 处屏幕哈希恰为官方 golden 检查点「首方块生成」的 screenSha256
 * （376f24bd…，见 golden/sw/checkpoints.json）——注意官方计周期的口径约为本机 2.3 倍
 * （其检查点 5,344,667 ≈ 本机 12,300,000），不影响状态等价性。
 *
 * 另一实测结论：该 tetris 只在方块移动/锁定时绘制像素——生成后不按键的话
 * 方块要等落底才可见（官方回放脚本首事件恰在生成后 1 周期）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HackMachine } from '../src/hack/computer';
import { parseHack } from '../src/hack/rom';
import { makeEngine } from '../src/testkit/engineFactory';

const ENABLED = !!process.env['TETRIS_DIFF'];

describe.skipIf(!ENABLED)('M6 · tetris 程序级差分（TETRIS_DIFF=1 开启）', () => {
  it('与官方行为核逐字节一致（RAM + 屏幕区 SHA-256）', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rom = parseHack(readFileSync(join(here, '..', 'src', 'hack', 'programs', 'tetris.hack'), 'utf-8'));
    const N = 3_000_000;

    const modUrl = pathToFileURL('C:/works/nand-computer/software/demo/engine.js').href;
    const { HackCore } = await import(modUrl);
    const core = new HackCore(rom);
    for (let i = 0; i < N; i++) core.step();

    const hashOf = (words: number[] | Uint16Array, off: number, len: number): string => {
      const bytes = Buffer.alloc(len * 2);
      for (let i = 0; i < len; i++) {
        const w = (words[off + i] ?? 0) & 0xffff;
        bytes[i * 2] = w >> 8;
        bytes[i * 2 + 1] = w & 0xff;
      }
      return createHash('sha256').update(bytes).digest('hex');
    };

    const m = new HackMachine(makeEngine(), { program: rom });
    m.runCycles(N);

    expect(hashOf(m.ram.mem, 0, 0x4000)).toBe(hashOf(core.ram, 0, 0x4000));
    const mineScreen = hashOf(m.screen.words, 0, 8192);
    expect(mineScreen).toBe(hashOf(core.ram, 0x4000, 8192));
    // 与官方 golden 检查点的哈希口径对齐（8192 屏幕字大端展开）
    console.log('MINE screen @3M:', mineScreen);
  }, 600_000);
});
