import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover'],
      thresholds: {
        statements: 40,
        branches: 100,
        functions: 40,
        lines: 40,
      },
    },
  },
});
