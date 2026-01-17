import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/analyzer/index.ts',
    'src/generator/index.ts'
  ],
  format: ['esm', 'cjs'],
  clean: true,
  dts: true,
});