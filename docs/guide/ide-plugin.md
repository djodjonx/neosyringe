# IDE Plugin

Get real-time error detection in your editor.

## Overview

The NeoSyringe LSP plugin integrates with TypeScript's language service to provide comprehensive real-time validation:

- 🔴 **Missing dependency detection** - Shows ALL missing dependencies at once, not just the first one
- 🔴 **Circular dependency detection** - Instant feedback when you create cycles
- 🔴 **Duplicate registration detection** - Warnings for conflicts in parent containers or partialConfigs
- 🎯 **Precise error positioning** - Errors point to the exact token, even for imported services
- 💡 **Clean error messages** - Readable names without internal hash IDs

### What's Validated

The plugin validates dependencies across:
- **defineBuilderConfig**: Local injections + parent containers + extends
- **definePartialConfig**: Local injections only
- **Cross-file imports**: Services imported from other files work correctly
- **Constructor dependencies**: Automatically extracts required dependencies from class constructors

## Setup

### Step 1: Add to `tsconfig.json`

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" }
    ]
  }
}
```

::: tip No build-plugin options apply here
This entry only takes `name`. Options like `debug` (see [Generated Code](/guide/generated-code#debugging)) belong to the ts-patch **transformer** entry (`{ "transform": "@djodjonx/neosyringe-plugin/transformer" }`) — a separate plugin from this one. The LSP never generates a container, so nothing about codegen applies to it.
:::

### Step 2: Use Workspace TypeScript

The plugin only works with the workspace TypeScript version.

#### VS Code

1. Open Command Palette: `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Search for: **"TypeScript: Select TypeScript Version"**
3. Select: **"Use Workspace Version"**

#### JetBrains IDEs (WebStorm, IntelliJ)

1. Go to **Settings** → **Languages & Frameworks** → **TypeScript**
2. Set TypeScript version to **"Project"** or point to `node_modules/typescript`

#### Neovim (with nvim-lspconfig)

```lua
require('lspconfig').tsserver.setup {
  init_options = {
    plugins = {
      {
        name = "@djodjonx/neosyringe-lsp",
        location = "./node_modules/@djodjonx/neosyringe/dist/lsp"
      }
    }
  }
}
```

### Step 3: Restart TypeScript Server

After configuration, restart the TypeScript server:

- **VS Code**: `Ctrl+Shift+P` → "TypeScript: Restart TS Server"
- **WebStorm**: File → Invalidate Caches / Restart

## Comprehensive Validation

### All Errors Shown at Once

Unlike build-time validation that stops at the first error, the LSP shows **all validation errors simultaneously**:

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: ServiceA },  // 🔴 Missing: ILogger
    { token: ServiceB },  // 🔴 Missing: ILogger  
    { token: ServiceC },  // 🔴 Missing: IDatabase
  ]
});
```

You'll see **3 errors in the Problems panel**, allowing you to fix all issues at once instead of one-by-one.

### Validation Context

The plugin validates dependencies based on context:

**For `definePartialConfig`**:
- Only checks local injections
- Reports missing dependencies within the partial config

**For `defineBuilderConfig`**:
- Checks local injections
- Validates against parent container (via `useContainer`)
- Validates against extended partials (via `extends`)
- Recursive validation through the entire dependency tree

**Priority**: Parent container → extends → local injections (with `scoped: true` overriding everything)

## Detected Errors

### Circular Dependency

```typescript
class A {
  constructor(private b: B) {}
}

class B {
  constructor(private a: A) {}  // 🔴 Cycle!
}

export const container = defineBuilderConfig({
  injections: [
    { token: A },
    { token: B }
  ]
});
// Error: [NeoSyringe] Circular dependency detected: A -> B -> A
```

### Missing Binding

The LSP detects when a service requires dependencies that aren't registered. It checks:
- Constructor parameters in classes
- All services in the container (not just the first error)
- Dependencies in parent containers and extends
- Cross-file imports

```typescript
interface ILogger {
  log(msg: string): void;
}

interface IEventBus {
  publish(event: any): void;
}

class InMemoryEventBus implements IEventBus {
  constructor(private logger: ILogger) {}  // Requires ILogger
  publish(event: any) {}
}

class UserService {
  constructor(
    private logger: ILogger,      // Requires ILogger
    private eventBus: IEventBus
  ) {}
}

export const container = defineBuilderConfig({
  injections: [
    // ILogger is NOT registered
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus },  // 🔴 Error!
    { token: UserService }  // 🔴 Error!
  ]
});
// Error on line with IEventBus: 
// [NeoSyringe] Missing binding: Service 'IEventBus' depends on 'ILogger', 
//              but no provider was registered.
//
// Error on line with UserService:
// [NeoSyringe] Missing binding: Service 'UserService' depends on 'ILogger',
//              but no provider was registered.
```

**All missing dependencies are shown at once**, helping you see the full picture.

**Error positioning**: The error appears on the exact line where the problematic service is registered, making it easy to locate and fix.

### Duplicate Registration

```typescript
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

export const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { token: useInterface<ILogger>(), provider: FileLogger }  // 🔴 Duplicate!
  ]
});
// Error: [NeoSyringe] Duplicate registration: 'ILogger' is already registered 
//        in the parent container. Use 'scoped: true' to override intentionally.
```

## Error Display

### Precise Error Positioning

Errors appear on the **exact token** that has the problem, not on the entire object:

```
┌─────────────────────────────────────────────────────────────────┐
│ container.ts                                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  export const container = defineBuilderConfig({                  │
│    injections: [                                                 │
│      { token: UserService }                                      │
│               ~~~~~~~~~~~  ← Error here, not on entire line      │
│               ▲                                                  │
│  ┌────────────┴───────────────────────────────────────────────┐ │
│  │ 🔴 [NeoSyringe] Missing binding: Service 'UserService'    │ │
│  │    depends on 'ILogger', but no provider was registered.   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key features**:
- Error positioned on the `token: ServiceName` property
- Works correctly even when services are imported from other files
- Clean error messages with readable names (no internal hash IDs)
- All errors shown simultaneously in the Problems panel

## Troubleshooting

### Plugin Not Working

1. **Check TypeScript version**: Must use workspace version
2. **Check tsconfig.json**: Plugin must be in `compilerOptions.plugins`
3. **Restart TS Server**: Changes require restart
4. **Check node_modules**: Package must be installed

### Errors Not Showing

1. **Save the file**: Some editors need file save to trigger
2. **Check file extension**: Only `.ts` and `.tsx` files
3. **Check if file has `defineBuilderConfig`**: Plugin only analyzes DI files

### False Positives

If the plugin reports errors that shouldn't exist:

1. Check that all imports are correct
2. Ensure interface names match
3. Try restarting the TypeScript server
