/**
 * Customize VitePress theme with NeoSyringe colors
 * Primary: Teal/Cyan (#0d9488)
 * Accent: Orange (#f97316)
 */
import { h } from 'vue'
import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: () => {
    return h(DefaultTheme.Layout, null, {})
  },
} satisfies Theme

