import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', serialize: 'src/serialize.ts' },
  format: ['esm', 'cjs'],
  clean: true,
  dts: true,
});
