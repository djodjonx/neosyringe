# Generated Code

Understand what the compiler produces.

## Overview

NeoSyringe transforms your configuration into optimized TypeScript at build time. This page shows what your code looks like before and after compilation.

## Before (Your Configuration)

```typescript
// container.ts
import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';

interface ILogger {
  log(msg: string): void;
}

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

class ApiService {
  constructor(
    private logger: ILogger,
    private apiUrl: string
  ) {}
}

const apiUrl = useProperty<string>(ApiService, 'apiUrl');

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: apiUrl, provider: () => process.env.API_URL ?? 'http://localhost' },
    { token: ApiService }
  ]
});
```

## After (Generated Code)

The build plugin replaces the entire file:

```typescript
// container.ts (after build)
import * as Import_0 from './container';

// -- Container --
class NeoContainer {
  private instances = new Map<any, any>();

  // -- Factories --

  private create_ILogger(): any {
    return new Import_0.ConsoleLogger();
  }

  private create_ApiService_apiUrl(): any {
    const userFactory = () => process.env.API_URL ?? 'http://localhost';
    return userFactory(this);
  }

  private create_ApiService(): any {
    return new Import_0.ApiService(
      this.resolve("ILogger"),
      this.resolve("PropertyToken:ApiService.apiUrl")
    );
  }

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'AppContainer'
  ) {}

  public resolve<T>(token: any): T {
    // 1. Try local resolution
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    // 2. Delegate to parent
    if (this.parent) {
      try {
        return this.parent.resolve(token);
      } catch (e: any) {
        if (!e?.message?.includes('Service not found or token not registered')) throw e;
      }
    }

    // 3. Delegate to legacy containers
    if (this.legacy) {
      for (const legacyContainer of this.legacy) {
        try {
          if (legacyContainer.resolve) return legacyContainer.resolve(token);
        } catch (e: any) {
          if (!e?.message?.includes('Service not found or token not registered')) throw e;
        }
      }
    }

    throw new Error(`[${this.name}] Service not found or token not registered: ${token}`);
  }

  public destroy(): void {
    this.instances.clear();
  }

  private resolveLocal(token: any): any {
    // Interface token (string-based)
    if (token === "ILogger") {
      if (!this.instances.has("ILogger")) {
        const instance = this.create_ILogger();
        this.instances.set("ILogger", instance);
        return instance;
      }
      return this.instances.get("ILogger");
    }

    // Property token (string-based)
    if (token === "PropertyToken:ApiService.apiUrl") {
      if (!this.instances.has("PropertyToken:ApiService.apiUrl")) {
        const instance = this.create_ApiService_apiUrl();
        this.instances.set("PropertyToken:ApiService.apiUrl", instance);
        return instance;
      }
      return this.instances.get("PropertyToken:ApiService.apiUrl");
    }

    // Class token (reference-based)
    if (token === Import_0.ApiService) {
      if (!this.instances.has(Import_0.ApiService)) {
        const instance = this.create_ApiService();
        this.instances.set(Import_0.ApiService, instance);
        return instance;
      }
      return this.instances.get(Import_0.ApiService);
    }

    return undefined;
  }

  public get _graph() {
    return ["ILogger", "PropertyToken:ApiService.apiUrl", "ApiService"];
  }
}

export const container = new NeoContainer(undefined, undefined, "AppContainer");
```

## Key Observations

### Token Resolution

| Token Type | Resolution Method | Example |
|------------|-------------------|---------|
| Interface | String comparison | `token === "ILogger"` |
| Class | Reference comparison | `token === Import_0.ApiService` |
| Property | String comparison | `token === "PropertyToken:ApiService.apiUrl"` |

### Singleton Pattern

Singletons use the `instances` Map and call private factory methods:

```typescript
if (!this.instances.has("ILogger")) {
  this.instances.set("ILogger", this.create_ILogger());
}
return this.instances.get("ILogger");
```

### Transient Pattern

Transients return directly without caching:

```typescript
if (token === "RequestContext") {
  return this.create_RequestContext();  // No caching!
}
```

### Dependency Injection

Dependencies are resolved recursively via `this.resolve`:

```typescript
private create_ApiService(): any {
  return new Import_0.ApiService(
    this.resolve("ILogger"),          // Resolves ILogger first
    this.resolve("PropertyToken:...")  // Resolves property
  );
}
```

## With Parent Container

When using `useContainer`:

```typescript
// Configuration
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [{ token: UserService }]
});
```

```typescript
// Generated
import { parent } from './parent-container';

class NeoContainer {
  constructor(
    private parent: typeof parent = parent,  // 👈 Parent reference
    // ...
  ) {}

  resolve(token: any): any {
    const local = this.resolveLocal(token);
    if (local !== undefined) return local;

    // Delegate to parent
    if (this.parent) {
      return this.parent.resolve(token);
    }
    
    throw new Error('...');
  }
}

export const child = new NeoContainer(parent);
```

## With Factory Provider

```typescript
// Configuration
{
  token: useInterface<IDatabase>(),
  provider: (container) => {
    const config = container.resolve(useInterface<IConfig>());
    return new PostgresDatabase(config.connectionString);
  }
}
```

```typescript
// Generated
private create_IDatabase(): any {
  const userFactory = (container) => {
    const config = container.resolve("IConfig");
    return new PostgresDatabase(config.connectionString);
  };
  return userFactory(this);
}
```

## Multiple Containers per File

When you declare multiple containers in the same file, each gets its own unique class:

### Before

```typescript
// containers.ts
export const userContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [{ token: UserService }]
});

export const productContainer = defineBuilderConfig({
  name: 'ProductModule',
  injections: [{ token: ProductService }]
});
```

### After

```typescript
// containers.ts (after build)
import * as Import_0 from './containers';

class NeoContainer_UserModule {
  private instances = new Map<any, any>();

  private create_UserService(): any {
    return new Import_0.UserService();
  }

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'UserModule'
  ) {}

  // resolve, destroy, resolveLocal...
}

export const userContainer = new NeoContainer_UserModule(undefined, undefined, "UserModule");

class NeoContainer_ProductModule {
  private instances = new Map<any, any>();

  private create_ProductService(): any {
    return new Import_0.ProductService();
  }

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'ProductModule'
  ) {}

  // resolve, destroy, resolveLocal...
}

export const productContainer = new NeoContainer_ProductModule(undefined, undefined, "ProductModule");
```

**Key points**:
- Each container gets a unique class name: `NeoContainer_{name}`
- The `name` field determines the class name
- If no `name` field, a hash is used: `NeoContainer_a1b2c3d4`

See [Multiple Containers](./multi-containers.md) for more details.

## Bundle Size Impact

| Aspect | Traditional DI | NeoSyringe |
|--------|---------------|-------------|
| Container library | 4-11 KB | 0 KB |
| reflect-metadata | ~3 KB | 0 KB |
| Generated code | N/A | ~50-200 lines |
| **Total** | **7-14 KB** | **< 1 KB** |

The generated code is:
- ✅ Tree-shakeable (unused services removed)
- ✅ Minifiable (standard JavaScript)
- ✅ No external dependencies

## Debugging

The generated container includes a `_graph` getter for inspection:

```typescript
console.log(container._graph);
// ["ILogger", "PropertyToken:ApiService.apiUrl", "ApiService"]
```

Each container also has a `name` for error messages:

```typescript
// Error: [AppContainer] Service not found or token not registered: UnknownToken
```
