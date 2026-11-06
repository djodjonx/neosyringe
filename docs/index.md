---
layout: home

hero:
  name: NeoSyringe
  text: Compile-Time DI
  tagline: Dependency injection resolved at build time. No reflection, no decorators, just pure TypeScript.
  image:
    src: /logo.png
    alt: NeoSyringe
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/djodjonx/neosyringe

features:
  - icon: ✨
    title: Interface as Tokens
    details: Native support for useInterface<ILogger>() without manual Symbols. TypeScript interfaces work seamlessly.
    
  - icon: 🚀
    title: Generated Containers
    details: No reflection, no reflect-metadata. The container is generated at build time, in a full or a minimal profile.
    
  - icon: 🛡️
    title: Compile-Time Safety
    details: Detect circular dependencies, missing bindings, and type mismatches instantly in your IDE.
    
  - icon: 🔄
    title: Gradual Migration
    details: Bridge existing containers like tsyringe or InversifyJS with useContainer while migrating.
    
  - icon: 📦
    title: Pure Classes
    details: Your business classes stay 100% pure - no decorators, no DI imports, no framework coupling.
    
  - icon: 🤖
    title: CI Validation
    details: Standalone CLI to verify your dependency graph before deployment.
---

<style>
:root {
  --vp-home-hero-name-color: transparent;
  --vp-home-hero-name-background: linear-gradient(135deg, #0d9488 0%, #f97316 100%);
}
</style>

## Why Choose NeoSyringe?

When a DI container resolves bindings at runtime, a missing or wrong binding shows up when `resolve()` runs. How other libraries behave is on the [alternatives page](/guide/alternatives), from their own documentation and with the access date.

NeoSyringe works as a **compiler plugin**:

- ✅ Generate optimized factories at build time
- ✅ Errors detected in your IDE
- ✅ Automatic interface IDs
- ✅ Pure TypeScript, no decorators

## Quick Example

```typescript
// Pure TypeScript - no decorators!
interface ILogger {
  log(msg: string): void;
}

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

class UserService {
  constructor(private logger: ILogger) {}
}

// Configure the container
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService }
  ]
});

// Use it with full type safety
const userService = container.resolve(UserService);
// Type: UserService ✅ - Full auto-completion!
```

The build plugin replaces your `defineBuilderConfig(...)` with a generated container class. No reflection, no decorators. Sizes are measured, never promised: see [Profiles](/guide/profiles).

<div style="text-align: center; margin-top: 3rem;">
  <a href="./guide/getting-started" style="
    display: inline-block;
    padding: 12px 24px;
    background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
    color: white;
    text-decoration: none;
    border-radius: 8px;
    font-weight: 600;
    transition: transform 0.2s;
  ">
    Get Started →
  </a>
</div>

