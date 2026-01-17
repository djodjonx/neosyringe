import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'], // LSP souvent CJS pour tsserver ?
  clean: true,
  dts: true,
});
