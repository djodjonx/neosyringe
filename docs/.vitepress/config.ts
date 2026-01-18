import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Neo-Syringe',
  description: 'Zero-Overhead, Compile-Time Dependency Injection for TypeScript',

  head: [
    ['link', { rel: 'icon', href: '/logo.png' }],
    ['meta', { name: 'theme-color', content: '#0d9488' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Neo-Syringe' }],
    ['meta', { property: 'og:description', content: 'Zero-Overhead, Compile-Time Dependency Injection for TypeScript' }],
    ['meta', { property: 'og:image', content: '/logo.png' }],
  ],

  base: '/neo-syringe/',

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
          { text: 'NPM', link: 'https://www.npmjs.com/package/@djodjonx/neo-syringe' },
          { text: 'Changelog', link: 'https://github.com/djodjonx/neosyringe/blob/main/CHANGELOG.md' },
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Neo-Syringe?', link: '/guide/what-is-neo-syringe' },
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Why Neo-Syringe?', link: '/guide/why-neo-syringe' },
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
            { text: 'Legacy Migration', link: '/guide/legacy-migration' },
            { text: 'Generated Code', link: '/guide/generated-code' },
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
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/djodjonx/neosyringe' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@djodjonx/neo-syringe' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Neo-Syringe Contributors'
    },

    search: {
      provider: 'local'
    },

    editLink: {
      pattern: 'https://github.com/djodjonx/neosyringe/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    }
  }
})

