import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },

  // Configure Vite with NeoSyringe plugin
  vite: {
    plugins: [neoSyringePlugin.vite()]
  },

  // TypeScript config
  typescript: {
    strict: true,
    typeCheck: false
  }
});