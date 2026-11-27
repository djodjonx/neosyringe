import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The plugin reads the light UI entry from its source, so the suite needs no fresh UI build.
      '@djodjonx/neosyringe-ui/serialize': fileURLToPath(new URL('../ui/src/serialize.ts', import.meta.url)),
    },
  },
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
