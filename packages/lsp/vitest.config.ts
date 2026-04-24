import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover'],
      thresholds: {
        statements: 96,
        branches: 85,
        functions: 95,
        lines: 98,
      },
    },
  },
});
