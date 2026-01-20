import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  vite: {
    plugins: [neoSyringePlugin.vite()]
  },
})
