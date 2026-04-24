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
        // The CLI entry point (index.ts) is tested via integration tests that spawn a
        // child process. Unit tests import from core directly and don't instrument the
        // CLI source. Thresholds remain at 0 until CLI integration coverage is set up.
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
