import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'clover'],
      include: ['src/**'],
      thresholds: {
        statements: 42,
        branches: 44,
        functions: 46,
        lines: 43,
      },
    },
  },
});
