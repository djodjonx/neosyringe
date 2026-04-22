import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover'],
      // Thresholds are only enforced when running with --coverage (e.g. `pnpm test:coverage`).
      // They prevent silent coverage regression in CI — do not lower without justification.
      thresholds: {
        statements: 35,
        branches: 40,
        functions: 35,
        lines: 35,
      },
    },
  },
});
