# Getting Started

This guide will help you install Neosyringe and create your first container in 5 minutes.

## Installation

::: code-group

```bash [pnpm]
pnpm add @djodjonx/neosyringe
pnpm add -D @djodjonx/neosyringe-plugin
```

```bash [npm]
npm install @djodjonx/neosyringe
npm install -D @djodjonx/neosyringe-plugin
```

```bash [yarn]
yarn add @djodjonx/neosyringe
yarn add -D @djodjonx/neosyringe-plugin
```

:::

::: info Peer Dependencies
- `typescript` >= 5.0.0
- `unplugin` (required for build plugin)
:::

## Configure Your Bundler

Neosyringe works with all major bundlers through `unplugin`.

::: code-group

```typescript [Vite]
// vite.config.ts
import { defineConfig } from 'vite';
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineConfig({
  plugins: [neoSyringePlugin.vite()]
});
```

```typescript [Rollup]
// rollup.config.js
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default {
  plugins: [neoSyringePlugin.rollup()]
};
```

```javascript [Webpack]
// webpack.config.js
module.exports = {
  plugins: [require('@djodjonx/neosyringe-plugin').webpack()]
};
```

```typescript [esbuild]
// esbuild.config.js
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

await esbuild.build({
  plugins: [neoSyringePlugin.esbuild()]
});
```

:::

## Create Your First Container

### Step 1: Define Your Services

Create pure TypeScript classes and interfaces. **No decorators needed!**

```typescript
// services/logger.ts
export interface ILogger {
  log(msg: string): void;
}

export class ConsoleLogger implements ILogger {
  log(msg: string) {
    console.log(`[LOG] ${msg}`);
  }
}
```

```typescript
// services/user.service.ts
import type { ILogger } from './logger';

export class UserService {
  constructor(private logger: ILogger) {}

  createUser(name: string) {
    this.logger.log(`Creating user: ${name}`);
    return { id: crypto.randomUUID(), name };
  }
}
```

### Step 2: Configure the Container

::: tip Best Practice
Put your container configuration in a **dedicated file** (e.g., `container.ts`). The plugin replaces the entire file content with generated code.
:::

```typescript
// container.ts
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import { ILogger, ConsoleLogger } from './services/logger';
import { UserService } from './services/user.service';

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // Bind interface to implementation
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    
    // Autowire class (dependencies resolved automatically)
    { token: UserService }
  ]
});
```

### Step 3: Use the Container

```typescript
// main.ts
import { container } from './container';
import { UserService } from './services/user.service';

// Resolve and use
const userService = container.resolve(UserService);
const user = userService.createUser('John Doe');

console.log(user); // { id: 'xxx-xxx', name: 'John Doe' }
```

## Project Structure

Recommended project structure:

```
src/
├── container.ts          # ✅ Container configuration
├── services/
│   ├── logger.ts         # Pure service
│   ├── user.service.ts   # Pure service
│   └── index.ts          # Barrel exports
└── main.ts               # Application entry
```

## Development Mode

✅ **The plugin works in dev mode** with full HMR support!

The `transform` hook is called on every file change, so your container is regenerated instantly during development.

## What's Next?

- [Basic Usage](/guide/basic-usage) - Learn all injection types
- [Lifecycle](/guide/lifecycle) - Singleton vs Transient
- [Scoped Injections](/guide/scoped-injections) - Override parent tokens
- [IDE Plugin](/guide/ide-plugin) - Real-time error detection

