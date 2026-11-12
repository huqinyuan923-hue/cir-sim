import { defineConfig } from 'vitest/config';

// 程序级差分：俄罗斯方块 300 万周期与 nand-computer 官方行为核逐字节对拍。
// 默认不参与 npm test（耗时约 40 秒），用 npm run test:long 显式触发。
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/m6-tetris-diff.test.ts'],
    env: { TETRIS_DIFF: '1' },
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});