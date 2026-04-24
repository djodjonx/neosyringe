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
        statements: 40,
        branches: 0,
        functions: 40,
        lines: 40,
      },
    },
  },
});
