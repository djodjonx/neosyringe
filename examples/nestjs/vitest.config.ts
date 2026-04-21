import { defineConfig } from 'vitest/config';
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineConfig({
  plugins: [neoSyringePlugin.vite()],
  test: {
    globals: true,
  },
});
