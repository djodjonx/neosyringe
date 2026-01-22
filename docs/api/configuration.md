# Configuration

Configure NeoSyringe in your project.

## Build Plugin

### Vite

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineConfig({
  plugins: [neoSyringePlugin.vite()]
});
```

### Rollup

```typescript
// rollup.config.js
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default {
  input: 'src/main.ts',
  output: {
    file: 'dist/bundle.js',
    format: 'esm'
  },
  plugins: [neoSyringePlugin.rollup()]
};
```

### Webpack

```javascript
// webpack.config.js
const { webpack } = require('@djodjonx/neosyringe-plugin');

module.exports = {
  plugins: [webpack()]
};
```

### esbuild

```typescript
// esbuild.config.js
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/bundle.js',
  plugins: [neoSyringePlugin.esbuild()]
});
```

### Rspack

```javascript
// rspack.config.js
const { rspack } = require('@djodjonx/neosyringe-plugin');

module.exports = {
  plugins: [rspack()]
};
```

## TypeScript LSP Plugin

Add to `tsconfig.json` for IDE error detection:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" }
    ]
  }
}
```

::: tip VS Code
Remember to select "Use Workspace Version" for TypeScript.
:::

## BuilderConfig Options

```typescript
defineBuilderConfig({
  // Container name (for debugging)
  name: 'AppContainer',
  
  // List of injections
  injections: [
    { token: UserService },
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ],
  
  // Inherit from partial configs
  extends: [loggingPartial, databasePartial],
  
  // Parent container (NeoSyringe or legacy)
  useContainer: parentContainer
});
```

### name

Type: `string`

Optional but **recommended**. The container name is used for:

1. **Error messages** - Helps identify which container has an issue
2. **Container ID** - Generates unique class names when multiple containers are in the same file
3. **Debugging** - Passed to the generated container constructor

```typescript
defineBuilderConfig({
  name: 'UserModule'
});

// Error: [UserModule] Service not found: XYZ
```

**Multiple containers per file**:

When declaring multiple containers in the same file, the `name` field **must be unique**:

```typescript
// ✅ GOOD - Unique names
export const userContainer = defineBuilderConfig({
  name: 'UserModule',  // Generates: class NeoContainer_UserModule
  injections: [/* ... */]
});

export const productContainer = defineBuilderConfig({
  name: 'ProductModule',  // Generates: class NeoContainer_ProductModule
  injections: [/* ... */]
});
```

```typescript
// ❌ ERROR - Duplicate names
export const containerA = defineBuilderConfig({
  name: 'MyContainer',
  injections: [/* ... */]
});

export const containerB = defineBuilderConfig({
  name: 'MyContainer',  // Error: Duplicate container name!
  injections: [/* ... */]
});
```

If no `name` is provided, a hash-based ID is generated (not recommended):

```typescript
defineBuilderConfig({
  injections: [/* ... */]  // Generates: class NeoContainer_a1b2c3d4
});
```

See [Multiple Containers](../guide/multi-containers.md) for details.

### injections

Type: `Injection[]`

Required. List of services to register.

```typescript
defineBuilderConfig({
  injections: [
    // Class autowiring
    { token: UserService },
    
    // Interface binding
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    
    // Explicit provider
    { token: BaseService, provider: ConcreteService },
    
    // Factory
    { token: useInterface<IConfig>(), provider: () => loadConfig() },
    
    // Property token
    { token: useProperty<string>(ApiService, 'apiUrl'), provider: () => 'http://...' },
    
    // With lifecycle
    { token: RequestContext, lifecycle: 'transient' },
    
    // Scoped override
    { token: useInterface<ILogger>(), provider: MockLogger, scoped: true }
  ]
});
```

### extends

Type: `PartialConfig[]`

Optional. Inherit injections from partial configs.

```typescript
const loggingPartial = definePartialConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

defineBuilderConfig({
  extends: [loggingPartial],
  injections: [
    { token: UserService }  // Can use ILogger
  ]
});
```

### useContainer

Type: `Container | any`

Optional. Parent container for delegation.

```typescript
// NeoSyringe parent
defineBuilderConfig({
  useContainer: sharedKernel,
  injections: [...]
});

// Legacy container (tsyringe, etc.)
const legacy = declareContainerTokens<{...}>(tsyringeContainer);
defineBuilderConfig({
  useContainer: legacy,
  injections: [...]
});
```

## Injection Options

```typescript
interface Injection<T> {
  token: Token<T>;
  provider?: Provider<T>;
  useFactory?: boolean;
  lifecycle?: 'singleton' | 'transient';
  scoped?: boolean;
}
```

### token

Type: `Token<T>` (required)

What to register. Can be:

- Class constructor: `UserService`
- Interface token: `useInterface<ILogger>()`
- Property token: `useProperty<string>(ApiService, 'apiUrl')`

### provider

Type: `Provider<T>`

What provides the instance. Can be:

- Class constructor: `ConsoleLogger`
- Factory function: `(container) => new Service()`

If omitted, the token itself is used (autowiring).

### useFactory

Type: `boolean`

Force treating the provider as a factory function.

```typescript
// Auto-detected (arrow function)
{ provider: () => createService() }

// Explicit (regular function)
{ provider: createService, useFactory: true }
```

### lifecycle

Type: `'singleton' | 'transient'`

Default: `'singleton'`

How instances are managed.

```typescript
{ token: UserService, lifecycle: 'singleton' }  // One instance
{ token: RequestContext, lifecycle: 'transient' }  // New each time
```

### scoped

Type: `boolean`

Default: `false`

If `true`, resolve locally instead of delegating to parent.

```typescript
// Override parent's ILogger with local MockLogger
{ token: useInterface<ILogger>(), provider: MockLogger, scoped: true }
```

See [Scoped Injections](/guide/scoped-injections) for details.

