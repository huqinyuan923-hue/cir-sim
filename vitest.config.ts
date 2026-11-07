import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // 性能基准（engine/canvas 拷入的 perf.bench + 本部 m6-bench）对 CPU 竞争敏感，
    // 并行跑全量时会互相干扰导致阈值抖动 → 默认排除，统一走 `npm run bench`（串行）。
    exclude: ['tests/**/perf.bench.test.ts', 'tests/m6-bench.test.ts', '**/node_modules/**'],
  },
});
