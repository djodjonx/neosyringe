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
        statements: 82,
        branches: 75,
        functions: 91,
        lines: 85,
      },
    },
  },
});
