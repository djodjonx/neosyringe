# Injection Types

All the ways to define and inject dependencies in Neosyringe.

## Overview

| Type | Syntax | Use Case |
|------|--------|----------|
| **Class** | `{ token: MyClass }` | Simple autowiring |
| **Interface** | `{ token: useInterface<IFoo>(), provider: Foo }` | Abstraction |
| **Explicit** | `{ token: MyClass, provider: OtherClass }` | Override default |
| **Factory** | `{ token: X, provider: (c) => ... }` | Dynamic creation |
| **Property** | `{ token: useProperty(Class, 'param') }` | Primitives |

## Class Token

Register a class directly. Dependencies are resolved automatically from constructor parameters.

```typescript
class Repository {
  findAll() { return []; }
}

class Service {
  constructor(private repo: Repository) {}
}

export const container = defineBuilderConfig({
  injections: [
    { token: Repository },
    { token: Service }  // Repository injected automatically
  ]
});
```

## Interface Token

Bind an interface to a concrete implementation using `useInterface<T>()`.

```typescript
import { useInterface } from '@djodjonx/neosyringe';

interface ICache {
  get(key: string): any;
  set(key: string, value: any): void;
}

class RedisCache implements ICache {
  get(key: string) { /* ... */ }
  set(key: string, value: any) { /* ... */ }
}

class MemoryCache implements ICache {
  private store = new Map();
  get(key: string) { return this.store.get(key); }
  set(key: string, value: any) { this.store.set(key, value); }
}

// Production
const prodContainer = defineBuilderConfig({
  injections: [
    { token: useInterface<ICache>(), provider: RedisCache }
  ]
});

// Development
const devContainer = defineBuilderConfig({
  injections: [
    { token: useInterface<ICache>(), provider: MemoryCache }
  ]
});
```

### How It Works

At compile-time, `useInterface<ICache>()` is replaced with a unique string ID:

```typescript
// Before (your code)
{ token: useInterface<ICache>(), provider: RedisCache }

// After (generated)
{ token: "ICache", provider: RedisCache }
```

## Explicit Provider

Override which class is used when resolving a token:

```typescript
class UserService {
  validate(user: User) { /* production logic */ }
}

class TestUserService extends UserService {
  validate(user: User) { return true; } // Skip validation in tests
}

// Test container
const testContainer = defineBuilderConfig({
  injections: [
    { token: UserService, provider: TestUserService }
  ]
});

const service = testContainer.resolve(UserService);
// service instanceof TestUserService === true
```

## Factory Provider

Use factory functions when you need:
- Dynamic configuration
- Container access for conditional resolution
- External resource initialization

### Arrow Function (Auto-detected)

```typescript
{
  token: useInterface<IConfig>(),
  provider: () => ({
    apiUrl: process.env.API_URL,
    environment: process.env.NODE_ENV
  })
}
```

### Factory with Container Access

```typescript
{
  token: useInterface<IHttpClient>(),
  provider: (container) => {
    const config = container.resolve(useInterface<IConfig>());
    const logger = container.resolve(useInterface<ILogger>());
    
    return new HttpClient({
      baseUrl: config.apiUrl,
      logger,
      timeout: config.timeout
    });
  }
}
```

### Explicit Factory Flag

For regular functions that aren't arrow functions:

```typescript
function createDatabaseConnection(container: Container) {
  const config = container.resolve(useInterface<IDbConfig>());
  return new DatabaseConnection(config.connectionString);
}

{
  token: useInterface<IDatabase>(),
  provider: createDatabaseConnection,
  useFactory: true  // Required for non-arrow functions
}
```

## Property Token

Inject primitive values (string, number, boolean) into class constructors.

### The Problem

How do you inject configuration values without polluting your classes?

```typescript
// ❌ Coupled to DI
class ApiService {
  constructor(@inject('API_URL') private apiUrl: string) {}
}

// ❌ Coupled to environment
class ApiService {
  private apiUrl = process.env.API_URL;
}
```

### The Solution

Use `useProperty<T>(Class, 'paramName')`:

```typescript
import { useProperty } from '@djodjonx/neosyringe';

// ✅ Pure class
class ApiService {
  constructor(
    private apiUrl: string,
    private timeout: number,
    private retryCount: number
  ) {}
}

// Property tokens
const apiUrl = useProperty<string>(ApiService, 'apiUrl');
const timeout = useProperty<number>(ApiService, 'timeout');
const retryCount = useProperty<number>(ApiService, 'retryCount');

export const container = defineBuilderConfig({
  injections: [
    { token: apiUrl, provider: () => 'https://api.example.com' },
    { token: timeout, provider: () => 5000 },
    { token: retryCount, provider: () => 3 },
    { token: ApiService }  // All primitives injected!
  ]
});
```

### Scoped to Class

Property tokens are scoped to their class, avoiding collisions:

```typescript
const serviceAUrl = useProperty<string>(ServiceA, 'url');
const serviceBUrl = useProperty<string>(ServiceB, 'url');

// serviceAUrl !== serviceBUrl (different tokens!)
```

### Validated by LSP

The IDE plugin validates property names:

```typescript
const invalid = useProperty<string>(ApiService, 'invalidParam');
// 🔴 Error: Parameter 'invalidParam' does not exist in ApiService constructor
```

## Combined Example

```typescript
import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';

// Interfaces
interface ILogger { log(msg: string): void; }
interface IHttpClient { get(url: string): Promise<any>; }

// Implementations
class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

// Pure service class
class ApiService {
  constructor(
    private logger: ILogger,
    private http: IHttpClient,
    private baseUrl: string,
    private timeout: number
  ) {}
}

// Tokens
const baseUrl = useProperty<string>(ApiService, 'baseUrl');
const timeout = useProperty<number>(ApiService, 'timeout');

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // Interface bindings
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    
    // Factory for complex initialization
    {
      token: useInterface<IHttpClient>(),
      provider: (container) => {
        const logger = container.resolve(useInterface<ILogger>());
        return new HttpClient(logger);
      }
    },
    
    // Primitive values
    { token: baseUrl, provider: () => process.env.API_URL ?? 'http://localhost' },
    { token: timeout, provider: () => 5000 },
    
    // Service with mixed dependencies
    { token: ApiService }
  ]
});
```

