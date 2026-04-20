# What is NeoSyringe?

NeoSyringe is a **next-generation dependency injection system** for TypeScript that shifts resolution from **runtime** to **build-time**.

## The Problem with Traditional DI

Traditional DI containers (InversifyJS, tsyringe, Awilix) all work the same way:

```typescript
// Traditional approach
@injectable()
class UserService {
  constructor(@inject(TYPES.ILogger) private logger: ILogger) {}
}

// At runtime
container.resolve(UserService); // ← Resolution happens HERE
```

This approach has several drawbacks:

| Issue | Impact |
|-------|--------|
| **Runtime overhead** | DI container code shipped to production |
| **Reflection required** | Need `reflect-metadata` and decorators |
| **Interface erasure** | Must use Symbols or string tokens manually |
| **Late errors** | Missing bindings only discovered at runtime |
| **Framework coupling** | Classes polluted with DI decorators |

## The NeoSyringe Solution

NeoSyringe works as a **compiler plugin** that analyzes your configuration and generates optimized code:

```typescript
// Your code (pure TypeScript!)
interface ILogger {
  log(msg: string): void;
}

class UserService {
  constructor(private logger: ILogger) {}
}

// Configuration
export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService }
  ]
});
```

At build time, the build plugin replaces the `defineBuilderConfig(...)` call with a generated container — just plain TypeScript, no DI library included.

## Key Advantages

### 🚀 Zero Runtime Overhead

No DI library shipped to production. Just pure factory functions that create instances directly.

### ✨ Native Interface Support

Use `useInterface<ILogger>()` instead of managing Symbols. The compiler generates unique IDs automatically.

### 🛡️ Compile-Time Safety

Errors are detected in your IDE before you even save the file:

- Circular dependencies
- Missing bindings
- Duplicate registrations
- Type mismatches

### 📦 Pure Classes

Your business classes have **zero DI dependencies**:

```typescript
// ✅ Pure TypeScript class
class UserService {
  constructor(private logger: ILogger) {}
}

// ❌ Traditional approach (polluted)
@injectable()
class UserService {
  constructor(@inject(TYPES.ILogger) private logger: ILogger) {}
}
```

### 🔄 Gradual Migration

Bridge existing containers while migrating:

```typescript
export const container = defineBuilderConfig({
  useContainer: legacyTsyringeContainer, // ← Delegate to legacy
  injections: [
    { token: NewService } // New services in NeoSyringe
  ]
});
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                      BUILD TIME                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. defineBuilderConfig({...})                              │
│              │                                               │
│              ▼                                               │
│  2. TypeScript Plugin analyzes configuration                │
│              │                                               │
│              ▼                                               │
│  3. Generates optimized NeoContainer class                  │
│              │                                               │
│              ▼                                               │
│  4. Replaces defineBuilderConfig with generated code        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       RUNTIME                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  container.resolve(UserService)                             │
│              │                                               │
│              ▼                                               │
│  Generated factory creates UserService with                 │
│  all dependencies resolved recursively                      │
│                                                              │
│  ✅ No reflection                                            │
│  ✅ No DI library in your bundle                             │
│  ✅ Errors caught at compile-time                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Next Steps

- [Getting Started](/guide/getting-started) - Install and configure NeoSyringe
- [Basic Usage](/guide/basic-usage) - Learn the core concepts
- [Why NeoSyringe?](/guide/why-neo-syringe) - Detailed comparison with alternatives

