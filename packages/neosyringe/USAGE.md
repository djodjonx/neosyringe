# NeoSyringe — Offline Usage Guide

Condensed reference bundled with the npm package, for offline/sandboxed environments
without access to the full docs at <https://djodjonx.github.io/neosyringe/>.

## Packages

| Package | What it's for | Import from it? |
|---|---|---|
| `@djodjonx/neosyringe` | Runtime API: `defineBuilderConfig`, `useInterface`, `useProperty`, types | Yes — your application code |
| `@djodjonx/neosyringe-plugin` | Build integration (Vite/Rollup/Webpack/esbuild plugin, `tsc`/ts-patch transformer) | Yes — build config only |
| `@djodjonx/neosyringe-core` | Internal analyzer/generator, shared by the plugin, LSP, and CLI | No — implementation detail |

## Minimal Setup

```bash
npm install @djodjonx/neosyringe
npm install -D @djodjonx/neosyringe-plugin
```

```typescript
// vite.config.ts (or rollup.config.js / webpack.config.js / esbuild build script)
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default {
  plugins: [neoSyringePlugin.vite()], // .rollup() / .webpack() / .esbuild()
};
```

No bundler? Use ts-patch instead — see `tsconfig.json` snippet below.

```json
// tsconfig.json (ts-patch, no bundler required)
{
  "compilerOptions": {
    "plugins": [
      { "transform": "@djodjonx/neosyringe-plugin/transformer", "transformProgram": true }
    ]
  }
}
```

## Your First Container

```typescript
// services/logger.ts
export interface ILogger { log(msg: string): void; }
export class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(`[LOG] ${msg}`); }
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

```typescript
// container.ts — a bare `return defineBuilderConfig(...)` is NOT supported (see
// "Unsupported Container Shape" below); assign to a const first.
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import { ILogger, ConsoleLogger } from './services/logger';
import { UserService } from './services/user.service';

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService },
  ],
});
```

```typescript
// main.ts
import { container } from './container';
import { UserService } from './services/user.service';

const userService = container.resolve(UserService); // fully typed, no assertions
userService.createUser('John Doe');
```

## Key Facts (easy to get wrong)

- **`useInterface<T>()` token identity is by type declaration, not call site.** Calling it for the same interface `T` in different files produces the *same token* everywhere. Confining registrations to one file per module is a readability convention, not a technical requirement.
- **`useValue` only works with interface tokens (`useInterface<T>()`) and property tokens (`useProperty<T>()`)** — not class-constructor tokens. `{ token: SomeClass, useValue: instance }` throws `TypeMismatchError`. Use `{ token: SomeClass, provider: () => instance, useFactory: true }` instead.
- **`defineBuilderConfig(...)` must be assigned to a variable** (`const container = defineBuilderConfig({...})`, optionally `return container;` afterward) or written as `export default defineBuilderConfig({...})`. A bare `return defineBuilderConfig({...})` is rejected at build time (`UnsupportedContainerShapeError`).
- **Multiple containers in one file each get their own generated class**, uniquified by a hash — not by the `name` field. `name` only sets the display label used in error messages; it's optional and has no effect on correctness.
- **`useContainer` shares instances** (the child resolves the parent's actual singleton). **`extends` / `definePartialConfig` shares recipes** (each container gets its own independent instances). Pick based on whether you need shared state or just shared boilerplate.

## Troubleshooting — Error Text → Cause → Fix

| Error (verbatim, key part) | Cause | Fix |
|---|---|---|
| `Missing injection: 'X' required by 'Y' is not registered...` | `Y`'s constructor needs `X`, and nothing in this container (or its parent/extends chain) registers it | Register `X` in this container, a `useContainer` parent, or an `extends`-ed partial |
| `Circular dependency detected: A -> B -> A` | Two services depend on each other | Restructure — introduce an abstraction or invert the dependency direction |
| `Type mismatch: Provider 'X' is not assignable to token type 'Y'` | The provider class doesn't implement the interface the token was declared for | Use a provider that actually implements the interface |
| `useValue cannot be used with primitive type 'string'...` | `useValue` was given a primitive (string/number/boolean) | Use `useProperty<string>(TargetClass, 'paramName')` instead |
| `useValue cannot be used with a class token. Use provider: X...` | `useValue` was used with a class-constructor token instead of an interface/property token | `{ token: X, provider: () => instance, useFactory: true }` |
| `Async factory for 'X' cannot use lifecycle: 'transient'` | An async factory was registered with `lifecycle: 'transient'` | Remove `lifecycle: 'transient'` — async factories are always singleton |
| `Duplicate registration: 'X' is already registered...` | The same token is registered twice (locally, or already provided by a parent/partial) | Remove the duplicate, or add `scoped: true` for an intentional override |
| `Token 'X' is registered both with and without 'multi: true'` | Mixed `multi`/non-`multi` registrations for the same token | Make every registration for that token consistently use `multi: true` or not |
| `defineBuilderConfig() must be assigned to a variable...` | A bare `return defineBuilderConfig({...})` with no intermediate variable | `const container = defineBuilderConfig({...}); return container;` |
| `NeoServiceNotFoundError: [Name] Service not found or token not registered: X` (at **runtime**, not build time) | You resolved a token that isn't registered in that specific container (or its parent/legacy chain) | Check you're resolving from the right container; confirm the token is actually registered there |

## Full Documentation

This file is intentionally condensed. For the complete guide (injection types, lifecycle,
scoped injections, multi-container patterns, legacy migration, IDE plugin, CLI validator,
full API reference), see <https://djodjonx.github.io/neosyringe/> when you have network access.
