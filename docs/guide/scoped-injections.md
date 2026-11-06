# Scoped Injections

Override parent container tokens with local resolution using `scoped: true`.

## The Problem

When you use a parent container with `useContainer`, you might want to **override** a token for your specific module:

```typescript
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// ❌ This throws an error!
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { token: useInterface<ILogger>(), provider: FileLogger }  // Duplicate!
  ]
});
// Error: Duplicate registration: 'ILogger' is already registered in parent container 'parent'.
```

## The Solution: `scoped: true`

Use `scoped: true` to tell NeoSyringe that this token should be **resolved locally** instead of delegating to the parent:

```typescript
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { 
      token: useInterface<ILogger>(), 
      provider: FileLogger,
      scoped: true  // ✅ Resolved in THIS container
    }
  ]
});
```

## How It Works

### Without `scoped: true`

Resolution delegates to the parent:

```mermaid
sequenceDiagram
    participant Child as ChildContainer
    participant Parent as ParentContainer

    Child->>Parent: Not found locally, delegate
    Parent-->>Child: ConsoleLogger
```

### With `scoped: true`

Resolution stays local:

```mermaid
sequenceDiagram
    participant Child as ChildContainer

    Note over Child: Found locally (scoped) ✅
    Child-->>Child: Returns FileLogger
```

## Visual Comparison

```mermaid
sequenceDiagram
    participant Caller
    participant Child as ChildContainer
    participant Parent as ParentContainer

    Caller->>Child: resolve(ILogger)
    alt scoped: true
        Note right of Child: Found locally ✅
        Child-->>Caller: FileLogger
    else default (no scoped)
        Child->>Parent: Not found locally, delegate
        Parent-->>Child: ConsoleLogger
        Child-->>Caller: ConsoleLogger
    end
```

## Behavior Summary

| Aspect | Without `scoped` | With `scoped: true` |
|--------|------------------|---------------------|
| Token in parent | ❌ Duplicate error | ✅ Override allowed |
| Resolution | Delegates to parent | **Resolved locally** |
| Instance | Parent's instance | Container's own instance |
| Lifecycle | Parent's lifecycle | Can define different lifecycle |

## Use Cases

### 🧪 Testing with mocks

`scoped: true` replaces a token **for the services this container builds**. It does not rewire a service that the parent already owns. Test the consumer, not only the token:

<<< @/../examples/new-api/mock.ts#containers

What the example proves, by running it (`tests/e2e/t20-docs-examples.test.ts`):

- `child.resolve(Service).logger.name()` is `'fake'`. `Service` is registered in the child with `scoped: true`, so it is built there around the child's `FakeLogger`.
- `parent.resolve(Service).logger.name()` is `'real'`. This `Service` is **parent-owned**: replacing `Logger` in the child does not change it. If the child registered only the mock `Logger` and resolved `Service` through the parent, the test would see the real logger.
- With `app.override(...)` (full profile, plugin option `testOverrides: true`), the consumer is rebuilt around the mock and again around the real logger after `clearOverrides()`. Both calls are awaited. See [profiles](./profiles.md).

### 🔧 Module Isolation

Each module has its own instance of a shared token:

```typescript
const sharedKernel = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// User module - wants file logging
const userModule = defineBuilderConfig({
  useContainer: sharedKernel,
  injections: [
    { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
    { token: UserService }  // Uses FileLogger
  ]
});

// Order module - wants console logging (from parent)
const orderModule = defineBuilderConfig({
  useContainer: sharedKernel,
  injections: [
    { token: OrderService }  // Uses ConsoleLogger from parent
  ]
});
```

### ⚙️ Different Lifecycle

Parent uses singleton, child uses transient:

```typescript
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<IRequestContext>(), provider: RequestContext, lifecycle: 'singleton' }
  ]
});

// Child needs new instance per request
const requestScoped = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { 
      token: useInterface<IRequestContext>(), 
      provider: RequestContext,
      lifecycle: 'transient',  // Different lifecycle!
      scoped: true
    }
  ]
});
```

### 🔒 Encapsulation

Keep a local version without affecting other consumers:

```typescript
const shared = defineBuilderConfig({
  injections: [
    { token: useInterface<ICache>(), provider: RedisCache }
  ]
});

// This module needs its own cache
const isolatedModule = defineBuilderConfig({
  useContainer: shared,
  injections: [
    { 
      token: useInterface<ICache>(), 
      provider: MemoryCache,  // Local cache only
      scoped: true
    },
    { token: SensitiveService }
  ]
});

// Other modules still use RedisCache
const otherModule = defineBuilderConfig({
  useContainer: shared,
  injections: [
    { token: OtherService }  // Uses RedisCache
  ]
});
```

## Multi-Level Hierarchy

`scoped: true` works at any level:

```typescript
// Level 1: Infrastructure
const infrastructure = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }
  ]
});

// Level 2: Domain (inherits all)
const domain = defineBuilderConfig({
  useContainer: infrastructure,
  injections: [
    { token: UserRepository }
  ]
});

// Level 3: Test (overrides only ILogger)
const test = defineBuilderConfig({
  useContainer: domain,
  injections: [
    { token: useInterface<ILogger>(), provider: MockLogger, scoped: true }
    // IDatabase still comes from infrastructure
  ]
});

test.resolve(useInterface<ILogger>());    // MockLogger (scoped)
test.resolve(useInterface<IDatabase>());  // PostgresDatabase (from infrastructure)
test.resolve(UserRepository);              // From domain: parent-owned, so it keeps the Logger of its owner
```

If `UserRepository` must use `MockLogger`, register `UserRepository` in `test` as well (with `scoped: true`).

## Error Messages

When you forget `scoped: true`, the build reports `NEO_DUPLICATE_PROVIDER` with this message (`packages/core/src/analyzer/errors/ErrorFormatter.ts:41`):

```
Duplicate registration: 'ILogger' is already registered in parent container 'parent'.
```

Add `scoped: true` if replacing the parent's registration is intended.
