import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // 仅性能基准（串行跑，避免 CPU 竞争导致阈值抖动）：npm run bench
    include: [
      'tests/m6-bench.test.ts',
      'tests/engine/perf.bench.test.ts',
      'tests/canvas/perf.bench.test.ts',
    ],
  },
});
