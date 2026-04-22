<p align="center">
  <img src="https://raw.githubusercontent.com/djodjonx/neosyringe/main/logo/logo.png" alt="NeoSyringe" width="200">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@djodjonx/neosyringe"><img src="https://img.shields.io/npm/v/@djodjonx/neosyringe.svg?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/djodjonx/neosyringe/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/djodjonx/neosyringe/ci.yml?style=flat-square&label=tests" alt="Tests"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.0%20|%206-blue.svg?style=flat-square" alt="TypeScript"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://djodjonx.github.io/neosyringe/"><img src="https://img.shields.io/badge/docs-VitePress-0d9488.svg?style=flat-square" alt="Documentation"></a>
</p>

<h1 align="center">Zero-Overhead, Compile-Time Dependency Injection</h1>

<p align="center">
  <strong>NeoSyringe</strong> shifts DI resolution from <strong>Runtime</strong> to <strong>Build-Time</strong>.<br>
  No reflection, no decorators, just pure TypeScript.
</p>

<p align="center">
  <a href="https://djodjonx.github.io/neosyringe/"><strong>📚 Read the Documentation →</strong></a>
</p>

<p align="center">
  <a href="https://djodjonx.github.io/neosyringe/guide/getting-started">Getting Started</a> •
  <a href="https://djodjonx.github.io/neosyringe/guide/why-neo-syringe">Why NeoSyringe?</a> •
  <a href="https://djodjonx.github.io/neosyringe/api/types">API Reference</a>
</p>

---

## ✨ Features

- **IDE Plugin** - Real-time validation with **all errors shown at once**, precise error positioning
- **Use Interfaces as Tokens** - `useInterface<ILogger>()` without manual Symbols
- **Zero Runtime Overhead** - Generated factory functions, no DI library shipped
- **Compile-Time Safety** - Missing dependencies, cycles, and duplicates detected in your IDE
- **Pure Classes** - No decorators, no DI imports in your business code
- **Comprehensive Validation** - Validates across parent containers, extends, and partialConfigs
- **Gradual Migration** - Bridge existing containers (tsyringe, InversifyJS)
- **CI Validation** - CLI to verify your dependency graph

## 📦 Installation

```bash
# npm
npm install @djodjonx/neosyringe
npm install -D @djodjonx/neosyringe-plugin

# pnpm
pnpm add @djodjonx/neosyringe
pnpm add -D @djodjonx/neosyringe-plugin
```

## 🚀 Quick Example

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
```

```typescript
// container.ts
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const container = defineBuilderConfig({
  injections: [
    // Bind interface to implementation
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    
    // Autowire class (dependencies resolved automatically)
    { token: UserService }
  ]
});

// Use it
const userService = container.resolve(UserService);
```

At build time, this generates optimized factory functions. **Zero DI library shipped to production!**

## 📖 Documentation

For complete documentation, visit **[djodjonx.github.io/neosyringe](https://djodjonx.github.io/neosyringe/)**

| Topic | Description |
|-------|-------------|
| [Getting Started](https://djodjonx.github.io/neosyringe/guide/getting-started) | Installation and first container |
| [Why NeoSyringe?](https://djodjonx.github.io/neosyringe/guide/why-neo-syringe) | Comparison with traditional DI |
| [Injection Types](https://djodjonx.github.io/neosyringe/guide/injection-types) | Classes, interfaces, factories, primitives |
| [Lifecycle](https://djodjonx.github.io/neosyringe/guide/lifecycle) | Singleton vs transient |
| [Multiple Containers](https://djodjonx.github.io/neosyringe/guide/multi-containers) | Organize multiple containers per file |
| [Scoped Injections](https://djodjonx.github.io/neosyringe/guide/scoped-injections) | Override parent container tokens |
| [Parent Container](https://djodjonx.github.io/neosyringe/guide/parent-container) | SharedKernel architecture |
| [Legacy Migration](https://djodjonx.github.io/neosyringe/guide/legacy-migration) | Bridge tsyringe, InversifyJS |
| [Generated Code](https://djodjonx.github.io/neosyringe/guide/generated-code) | What the compiler produces |
| [CLI Validator](https://djodjonx.github.io/neosyringe/guide/cli) | Validate in CI/CD |
| [IDE Plugin](https://djodjonx.github.io/neosyringe/guide/ide-plugin) | Real-time error detection |
| [API Reference](https://djodjonx.github.io/neosyringe/api/types) | Types and functions |

## 🔧 Build Plugin Setup

<details>
<summary><strong>Vite</strong></summary>

```typescript
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineConfig({
  plugins: [neoSyringePlugin.vite()]
});
```
</details>

<details>
<summary><strong>Rollup</strong></summary>

```typescript
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default {
  plugins: [neoSyringePlugin.rollup()]
};
```
</details>

<details>
<summary><strong>Webpack</strong></summary>

```javascript
module.exports = {
  plugins: [require('@djodjonx/neosyringe-plugin').webpack()]
};
```
</details>

<details>
<summary><strong>TypeScript compiler (ts-patch) — no bundler needed</strong></summary>

Install ts-patch and add the transformer to your `tsconfig.json`:

```bash
pnpm add -D ts-patch @djodjonx/neosyringe-plugin
```

```json
{
  "compilerOptions": {
    "plugins": [
      { "transform": "@djodjonx/neosyringe-plugin/transformer", "transformProgram": true }
    ]
  }
}
```

Add to `package.json` scripts so ts-patch patches TypeScript on install:

```json
{
  "scripts": {
    "prepare": "ts-patch install -s"
  }
}
```

`tsc` (and any CLI that uses it, like `nest build`) will then run the NeoSyringe transformer automatically.
</details>

## 🛡️ IDE Support

Get **comprehensive real-time validation** in your editor:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" }
    ]
  }
}
```

**What you get**:
- ✅ **All missing dependencies** shown at once (not just the first error)
- ✅ **Precise error positioning** on the exact token with the problem
- ✅ **Clean error messages** without internal hash IDs
- ✅ **Cross-file validation** works correctly with imported services
- ✅ **Context-aware** validates across parent containers and extends

See [IDE Plugin Guide](https://djodjonx.github.io/neosyringe/guide/ide-plugin) for setup details.

## 📄 License

MIT
