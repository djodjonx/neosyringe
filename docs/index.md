---
layout: home

hero:
  name: Neosyringe
  text: Compile-Time DI
  tagline: Zero-overhead dependency injection that shifts resolution from Runtime to Build-Time. No reflection, no decorators, just pure TypeScript.
  image:
    src: /logo.png
    alt: Neosyringe
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
    title: Zero Runtime Overhead
    details: No reflection, no reflect-metadata. Just pure factory functions generated at build time.
    
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

## Why Choose Neosyringe?

Traditional DI containers like InversifyJS and tsyringe rely on **runtime resolution**:

- ❌ Ship DI container logic to the browser
- ❌ Errors happen at runtime
- ❌ Interfaces are erased, requiring manual Symbols
- ❌ Need decorators and reflect-metadata

**Neosyringe is different.** It works as a **compiler plugin**:

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

// Use it
const userService = container.resolve(UserService);
```

## Generated Output

The build plugin transforms your configuration into optimized code:

```typescript
// Generated at build time
function create_ILogger() {
  return new ConsoleLogger();
}

function create_UserService(container) {
  return new UserService(container.resolve("ILogger"));
}

export class NeoContainer {
  resolve(token) {
    if (token === "ILogger") return this.getInstance("ILogger", create_ILogger);
    if (token === UserService) return this.getInstance(UserService, create_UserService);
    throw new Error(`Service not found: ${token}`);
  }
}
```

**Zero DI library shipped to production!**

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

