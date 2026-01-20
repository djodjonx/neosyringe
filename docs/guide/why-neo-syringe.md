# Why NeoSyringe?

A detailed comparison with other dependency injection solutions.

## Comparison Table

| Feature | NeoSyringe | tsyringe | InversifyJS | Awilix |
|---------|:-----------:|:--------:|:-----------:|:------:|
| **Zero runtime overhead** | ✅ | ❌ | ❌ | ❌ |
| **No decorators needed** | ✅ | ❌ | ❌ | ✅ |
| **No reflect-metadata** | ✅ | ❌ | ❌ | ✅ |
| **Interface as tokens** | ✅ | ❌ | ❌ | ❌ |
| **Compile-time validation** | ✅ | ❌ | ❌ | ❌ |
| **IDE error detection** | ✅ | ❌ | ❌ | ❌ |
| **Tree-shakeable** | ✅ | ❌ | ❌ | ❌ |
| **Works in Edge/Workers** | ✅ | ⚠️ | ⚠️ | ✅ |

## The Cost of Runtime DI

Traditional DI containers add significant overhead:

### Bundle Size

| Library | Min+Gzip |
|---------|----------|
| InversifyJS | ~11 KB |
| tsyringe | ~4 KB |
| Awilix | ~8 KB |
| **NeoSyringe** | **~0 KB** (generated) |

### Runtime Performance

```typescript
// Traditional (tsyringe) - Runtime resolution
container.resolve(UserService);
// 1. Look up token in registry
// 2. Check if singleton exists
// 3. Resolve all dependencies recursively
// 4. Create instance with reflection
// 5. Store singleton reference

// NeoSyringe - Direct instantiation
container.resolve(UserService);
// 1. Call generated factory function
// That's it!
```

## Code Quality Comparison

### Traditional Approach (tsyringe)

```typescript
import 'reflect-metadata';
import { injectable, inject } from 'tsyringe';

// Must define symbols manually
const TYPES = {
  ILogger: Symbol.for('ILogger'),
  IDatabase: Symbol.for('IDatabase'),
};

// Classes polluted with decorators
@injectable()
class UserService {
  constructor(
    @inject(TYPES.ILogger) private logger: ILogger,
    @inject(TYPES.IDatabase) private db: IDatabase
  ) {}
}

// Registration
container.register(TYPES.ILogger, { useClass: ConsoleLogger });
container.register(TYPES.IDatabase, { useClass: PostgresDatabase });
container.register(UserService, { useClass: UserService });
```

### NeoSyringe Approach

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// Pure class - no DI imports!
class UserService {
  constructor(
    private logger: ILogger,
    private db: IDatabase
  ) {}
}

// Clean configuration
export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IDatabase>(), provider: PostgresDatabase },
    { token: UserService }
  ]
});
```

## Error Detection

### Traditional: Runtime Errors

```typescript
// tsyringe - Error at RUNTIME
container.resolve(UserService);
// Error: Attempted to resolve unregistered dependency token: "ILogger"
// 💥 App crashes in production!
```

### NeoSyringe: Compile-Time Errors

```typescript
// NeoSyringe - Error in IDE instantly
export const container = defineBuilderConfig({
  injections: [
    { token: UserService } // UserService needs ILogger
  ]
});
// 🔴 [NeoSyringe] Missing binding: 'UserService' depends on 'ILogger'
// ✅ Fixed before you even save the file!
```

## Testing

### Traditional: Complex Mocking (tsyringe example)

```typescript
// ❌ tsyringe requires manual container reset and re-registration
import { container } from 'tsyringe';

beforeEach(() => {
  container.reset();  // tsyringe API, NOT NeoSyringe!
  container.register(TYPES.ILogger, { useClass: MockLogger });
  container.register(TYPES.IDatabase, { useClass: MockDatabase });
  container.register(UserService, { useClass: UserService });
});
```

### NeoSyringe: Natural Overrides

```typescript
// ✅ NeoSyringe - Create a test container that overrides production services
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import { productionContainer } from './container';

// Test container inherits from production but overrides specific services
const testContainer = defineBuilderConfig({
  useContainer: productionContainer,
  injections: [
    { token: useInterface<ILogger>(), provider: MockLogger, scoped: true },
    { token: useInterface<IDatabase>(), provider: MockDatabase, scoped: true }
  ]
});

// No reset needed - each test file can have its own container!
const userService = testContainer.resolve(UserService);
```

## Edge Computing / Workers

Traditional DI often fails in edge environments:

```typescript
// ❌ tsyringe in Cloudflare Workers
// Error: reflect-metadata requires global Reflect object

// ❌ InversifyJS in Vercel Edge
// Error: Cannot use decorators in Edge Runtime
```

NeoSyringe works everywhere:

```typescript
// ✅ NeoSyringe in any environment
// Generated code is pure JavaScript
class NeoContainer {
  resolve(token) {
    if (token === "ILogger") return new ConsoleLogger();
    // ... pure function calls
  }
}

export const container = new NeoContainer();
```

## Migration Path

You don't have to migrate everything at once:

```typescript
// Bridge legacy container
import { legacyContainer } from './legacy-tsyringe';
import { declareContainerTokens } from '@djodjonx/neosyringe';

const legacy = declareContainerTokens<{
  AuthService: AuthService;
  UserRepository: UserRepository;
}>(legacyContainer);

// New services use NeoSyringe
export const container = defineBuilderConfig({
  useContainer: legacy, // Delegate to legacy
  injections: [
    { token: NewService },
    { token: AnotherNewService }
  ]
});
```

## Summary

| Aspect | Traditional DI | NeoSyringe |
|--------|---------------|-------------|
| **When errors occur** | Runtime | Compile-time |
| **Bundle impact** | 4-11 KB | 0 KB |
| **Class purity** | Polluted with decorators | 100% pure |
| **Interface support** | Manual Symbols | Automatic |
| **Edge compatibility** | Limited | Full |
| **Performance** | Map lookups + reflection | Direct calls |

