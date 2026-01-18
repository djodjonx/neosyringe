# Generated Code

Understand what the compiler produces.

## Overview

Neosyringe transforms your configuration into optimized TypeScript at build time. This page shows what your code looks like before and after compilation.

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

// -- Factories --

function create_ILogger(container: NeoContainer) {
  return new Import_0.ConsoleLogger();
}

function create_ApiService_apiUrl(container: NeoContainer) {
  const userFactory = () => process.env.API_URL ?? 'http://localhost';
  return userFactory(container);
}

function create_ApiService(container: NeoContainer) {
  return new Import_0.ApiService(
    container.resolve("ILogger"),
    container.resolve("PropertyToken:ApiService.apiUrl")
  );
}

// -- Container --

export class NeoContainer {
  private instances = new Map<any, any>();

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'AppContainer'
  ) {}

  public resolve(token: any): any {
    // 1. Try local resolution
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    // 2. Delegate to parent
    if (this.parent) {
      try {
        return this.parent.resolve(token);
      } catch (e) {
        // Continue to legacy
      }
    }

    // 3. Delegate to legacy containers
    if (this.legacy) {
      for (const legacyContainer of this.legacy) {
        try {
          if (legacyContainer.resolve) {
            return legacyContainer.resolve(token);
          }
        } catch (e) {
          // Try next
        }
      }
    }

    throw new Error(`[${this.name}] Service not found: ${token}`);
  }

  private resolveLocal(token: any): any {
    // Interface token (string-based)
    if (token === "ILogger") {
      if (!this.instances.has("ILogger")) {
        this.instances.set("ILogger", create_ILogger(this));
      }
      return this.instances.get("ILogger");
    }

    // Property token (string-based)
    if (token === "PropertyToken:ApiService.apiUrl") {
      if (!this.instances.has("PropertyToken:ApiService.apiUrl")) {
        this.instances.set("PropertyToken:ApiService.apiUrl", create_ApiService_apiUrl(this));
      }
      return this.instances.get("PropertyToken:ApiService.apiUrl");
    }

    // Class token (reference-based)
    if (token === Import_0.ApiService) {
      if (!this.instances.has(Import_0.ApiService)) {
        this.instances.set(Import_0.ApiService, create_ApiService(this));
      }
      return this.instances.get(Import_0.ApiService);
    }

    return undefined;
  }

  public createChildContainer(): NeoContainer {
    return new NeoContainer(this, this.legacy, `Child of ${this.name}`);
  }

  // For debugging
  public get _graph() {
    return ["ILogger", "PropertyToken:ApiService.apiUrl", "ApiService"];
  }
}

export const container = new NeoContainer();
```

## Key Observations

### Token Resolution

| Token Type | Resolution Method | Example |
|------------|-------------------|---------|
| Interface | String comparison | `token === "ILogger"` |
| Class | Reference comparison | `token === Import_0.ApiService` |
| Property | String comparison | `token === "PropertyToken:ApiService.apiUrl"` |

### Singleton Pattern

Singletons use the `instances` Map:

```typescript
if (!this.instances.has("ILogger")) {
  this.instances.set("ILogger", create_ILogger(this));
}
return this.instances.get("ILogger");
```

### Transient Pattern

Transients return directly without caching:

```typescript
if (token === "RequestContext") {
  return create_RequestContext(this);  // No caching!
}
```

### Dependency Injection

Dependencies are resolved recursively:

```typescript
function create_ApiService(container: NeoContainer) {
  return new Import_0.ApiService(
    container.resolve("ILogger"),          // Resolves ILogger first
    container.resolve("PropertyToken:...")  // Resolves property
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

export class NeoContainer {
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
function create_IDatabase(container: NeoContainer) {
  const userFactory = (container) => {
    const config = container.resolve("IConfig");
    return new PostgresDatabase(config.connectionString);
  };
  return userFactory(container);
}
```

## Bundle Size Impact

| Aspect | Traditional DI | Neosyringe |
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
// Error: [AppContainer] Service not found: UnknownToken
```

