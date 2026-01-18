# IDE Plugin

Get real-time error detection in your editor.

## Overview

The NeoSyringe LSP plugin integrates with TypeScript's language service to provide:

- 🔴 **Circular dependency detection** - Instant feedback when you create cycles
- 🔴 **Missing binding detection** - Errors when dependencies aren't registered
- 🔴 **Duplicate registration detection** - Warnings for conflicts
- 💡 **Suggestions** - Helpful tips to fix issues

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

```typescript
interface ILogger {
  log(msg: string): void;
}

class UserService {
  constructor(private logger: ILogger) {}
}

export const container = defineBuilderConfig({
  injections: [
    { token: UserService }  // 🔴 ILogger not registered!
  ]
});
// Error: [NeoSyringe] Missing binding: 'UserService' depends on 'ILogger', 
//        but no provider registered.
```

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

## Screenshots

### Error in Editor

```
┌─────────────────────────────────────────────────────────────────┐
│ container.ts                                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  export const container = defineBuilderConfig({                  │
│    injections: [                                                 │
│      { token: UserService }                                      │
│               ~~~~~~~~~~~                                        │
│               ▲                                                  │
│               │                                                  │
│  ┌────────────┴───────────────────────────────────────────────┐ │
│  │ 🔴 [NeoSyringe] Missing binding: 'UserService' depends   │ │
│  │    on 'ILogger', but no provider registered.               │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Quick Fix Available

```
┌────────────────────────────────────────────┐
│ Quick Fix                                   │
├────────────────────────────────────────────┤
│ 💡 Add missing injection for ILogger       │
│ 💡 Mark as optional dependency             │
│ 💡 Ignore this error                       │
└────────────────────────────────────────────┘
```

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

## Configuration

Currently, the plugin uses default settings. Future versions may support:

```json
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@djodjonx/neosyringe-lsp",
        "options": {
          "strictMode": true,
          "warnOnUnusedProviders": true
        }
      }
    ]
  }
}
```

