import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  title: 'NeoSyringe',
  description: 'Zero-Overhead, Compile-Time Dependency Injection for TypeScript',

  mermaid: {
    // No explicit `theme`: the plugin already swaps in mermaid's 'dark'
    // theme when the site is in dark mode, and 'default' otherwise. Both
    // ship complete, well-contrasted line/text defaults — `theme: 'base'`
    // looked broken (invisible signal lines/text) since 'base' derives
    // those from primaryColor instead of using tested presets.
    themeVariables: {
      // Brand teal for the "boxes" (actors, notes, labels) — borrowed from
      // the site's own theme-color. Left unset: lineColor/signalColor/text
      // colors, so arrows and prose keep each mermaid theme's own
      // light/dark contrast instead of a single static color fighting one
      // of the two page themes.
      primaryColor: '#0d9488',
      primaryBorderColor: '#0f766e',
      primaryTextColor: '#ffffff',
      actorBkg: '#0d9488',
      actorBorder: '#0f766e',
      actorTextColor: '#ffffff',
      labelBoxBkgColor: '#0d9488',
      labelBoxBorderColor: '#0f766e',
      labelTextColor: '#ffffff',
      // loopTextColor draws directly on the page background (the "[condition]"
      // text next to an alt/loop block), not on a colored box — it defaults to
      // actorTextColor (white) if left unset, which is invisible in light mode.
      loopTextColor: '#6b7280',
      noteBkgColor: '#99f6e4',
      noteBorderColor: '#0f766e',
      noteTextColor: '#134e4a',
    },
  },

  head: [
    ['link', { rel: 'icon', href: '/logo.png' }],
    ['meta', { name: 'theme-color', content: '#0d9488' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'NeoSyringe' }],
    ['meta', { property: 'og:description', content: 'Zero-Overhead, Compile-Time Dependency Injection for TypeScript' }],
    ['meta', { property: 'og:image', content: '/logo.png' }],
  ],

  base: '/neosyringe/',

  themeConfig: {
    logo: '/logo.png',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/types' },
      {
        text: 'Examples',
        items: [
          { text: 'Basic Usage', link: '/guide/basic-usage' },
          { text: 'Parent Container', link: '/guide/parent-container' },
          { text: 'Legacy Migration', link: '/guide/legacy-migration' },
        ]
      },
      {
        text: 'Links',
        items: [
          { text: 'GitHub', link: 'https://github.com/djodjonx/neosyringe' },
          { text: 'NPM', link: 'https://www.npmjs.com/package/@djodjonx/neosyringe' },
          { text: 'Changelog', link: 'https://github.com/djodjonx/neosyringe/blob/main/CHANGELOG.md' },
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is NeoSyringe?', link: '/guide/what-is-neo-syringe' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Why NeoSyringe?', link: '/guide/why-neo-syringe' },
          ]
        },
        {
          text: 'Core Concepts',
          items: [
            { text: 'Basic Usage', link: '/guide/basic-usage' },
            { text: 'Injection Types', link: '/guide/injection-types' },
            { text: 'Lifecycle', link: '/guide/lifecycle' },
            { text: 'Scoped Injections', link: '/guide/scoped-injections' },
          ]
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Parent Container', link: '/guide/parent-container' },
            { text: 'Multiple Containers', link: '/guide/multi-containers' },
            { text: 'Legacy Migration', link: '/guide/legacy-migration' },
            { text: 'Async Factories', link: '/guide/async-factories' },
            { text: 'Disposable Services', link: '/guide/disposable' },
            { text: 'How It Works', link: '/guide/generated-code' },
          ]
        },
        {
          text: 'Tools',
          items: [
            { text: 'CLI Validator', link: '/guide/cli' },
            { text: 'IDE Plugin', link: '/guide/ide-plugin' },
          ]
        }
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Types', link: '/api/types' },
            { text: 'Functions', link: '/api/functions' },
            { text: 'Configuration', link: '/api/configuration' },
            { text: 'Error Reference', link: '/api/errors' },
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/djodjonx/neosyringe' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@djodjonx/neosyringe' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present NeoSyringe Contributors'
    },

    search: {
      provider: 'local'
    },

    editLink: {
      pattern: 'https://github.com/djodjonx/neosyringe/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    }
  }
}))

