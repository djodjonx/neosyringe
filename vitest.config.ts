import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover'],
      thresholds: {
        statements: 35,
        branches: 40,
        functions: 35,
        lines: 35,
      },
    },
  },
});
