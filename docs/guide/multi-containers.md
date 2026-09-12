# Multiple Containers per File

Learn how to organize multiple containers in a single file for better modularity.

## Overview

NeoSyringe allows you to declare **multiple `defineBuilderConfig`** in the same file. Each container gets a unique ID and is validated independently.

## Basic Example

```typescript
import { defineBuilderConfig } from '@djodjonx/neosyringe';

// Container for user module
export const userContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [
    { token: UserRepository },
    { token: UserService }
  ]
});

// Container for product module
export const productContainer = defineBuilderConfig({
  name: 'ProductModule',
  injections: [
    { token: ProductRepository },
    { token: ProductService }
  ]
});
```

## Generated Class Names vs. the `name` Field

Every `defineBuilderConfig()` call site gets its own generated class, uniquified by a **hash derived from its file and position** — `class NeoContainer_<hash>` — regardless of whether you set a `name` field or not. This is what makes it safe to declare any number of containers in the same file: two containers never collide, even with identical or absent `name` fields.

```typescript
export const userContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [/* ... */]
});
// Generates something like: class NeoContainer_2e10a6c1 { ... }

export const productContainer = defineBuilderConfig({
  // No name field — still gets its own unique class
  injections: [/* ... */]
});
// Generates something like: class NeoContainer_2e10a288 { ... }
```

The **`name` field is not part of the class identity** — it only sets the container's runtime `this.name`, which is purely a display label used in error messages:

```typescript
export const myContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [/* ... */]
});

// Error: [UserModule] Service not found or token not registered: SomeToken
//         ^^^^^^^^^^ — this is the `name` field, not the class name
```

::: tip `name` is optional and purely cosmetic
Setting `name` costs nothing and makes error messages much easier to read — but it has no effect on class generation, uniqueness, or correctness. Two containers with the same `name` (or no `name` at all) work exactly as well as two with distinct names; you just get a less specific label if either one throws.
:::

## Generated Code

### Source Code

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

### Generated Output

This is the real output (trimmed) captured from the build plugin for the source above — note the hash-suffixed class names, and that the `name` field only reaches the constructor's `name` argument, not the class identifier:

```typescript
// containers.ts (after build, via the inline unplugin transform)

class NeoServiceNotFoundError_3edbbbcb extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

class NeoContainer_3edbbbcb {
  private instances = new Map<any, any>();

  private create_UserRepository(): any {
    return new UserRepository();
  }

  private create_UserService(): any {
    return new UserService(this.resolve(UserRepository));
  }

  constructor(
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  // resolve, destroy, resolveLocal...
}

export const userContainer = new NeoContainer_3edbbbcb(undefined, "UserModule");

class NeoServiceNotFoundError_3edbc066 extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

class NeoContainer_3edbc066 {
  private instances = new Map<any, any>();

  private create_ProductRepository(): any {
    return new ProductRepository();
  }

  private create_ProductService(): any {
    return new ProductService(this.resolve(ProductRepository));
  }

  constructor(
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  // resolve, destroy, resolveLocal...
}

export const productContainer = new NeoContainer_3edbc066(undefined, "ProductModule");
```

## Naming Is Not Validated

Because the `name` field is purely cosmetic (see above), **nothing stops you from giving two containers the same `name`** — in the same file or across files. It is not a build error:

```typescript
export const containerA = defineBuilderConfig({
  name: 'MyContainer',
  injections: [{ token: ServiceA }]
});

export const containerB = defineBuilderConfig({
  name: 'MyContainer',  // Allowed — no error, no collision
  injections: [{ token: ServiceB }]
});
```

Both containers are generated correctly and behave independently — they just share the same label in error messages, which can make debugging slightly more ambiguous (`[MyContainer] Service not found: X` won't tell you *which* `MyContainer` threw it). That ambiguity, not a build failure, is the actual cost of a duplicate `name`.

::: tip Best practice
Give each container a distinct, descriptive `name` anyway — not because it's required, but because it makes error messages unambiguous.
:::

## Independent Validation

Each container is **validated independently**. Dependencies in one container don't affect another.

```typescript
export const containerA = defineBuilderConfig({
  name: 'ContainerA',
  injections: [
    { token: ServiceA }  // ❌ Missing: ILogger
  ]
});

export const containerB = defineBuilderConfig({
  name: 'ContainerB',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: ServiceB }  // ✅ OK - Has ILogger
  ]
});
```

**Result**:
- `ContainerA`: Error on `ServiceA` (missing ILogger)
- `ContainerB`: No errors (has all dependencies)

## Use Cases

### Modular Architecture

Organize containers by bounded context or feature:

```typescript
// di/containers.ts
export const authContainer = defineBuilderConfig({
  name: 'AuthModule',
  injections: [
    { token: AuthService },
    { token: TokenService }
  ]
});

export const userContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [
    { token: UserRepository },
    { token: UserService }
  ]
});

export const productContainer = defineBuilderConfig({
  name: 'ProductModule',
  injections: [
    { token: ProductRepository },
    { token: ProductService }
  ]
});
```

### Testing Containers

Keep test and production containers together:

```typescript
// container.ts
export const appContainer = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<IDatabase>(), provider: PostgresDB },
    { token: UserService }
  ]
});

export const testContainer = defineBuilderConfig({
  name: 'TestContainer',
  injections: [
    { token: useInterface<IDatabase>(), provider: InMemoryDB },  // Mock
    { token: UserService }
  ]
});
```

### Shared Kernel Pattern

Combine with `extends` for shared dependencies:

```typescript
const sharedKernel = definePartialConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: EventBus }
  ]
});

export const userModule = defineBuilderConfig({
  name: 'UserModule',
  extends: [sharedKernel],
  injections: [{ token: UserService }]
});

export const productModule = defineBuilderConfig({
  name: 'ProductModule',
  extends: [sharedKernel],
  injections: [{ token: ProductService }]
});

// Both modules share ILogger and IEventBus
```

## Container Hierarchy

Containers can reference each other using `useContainer`:

```typescript
export const parentContainer = defineBuilderConfig({
  name: 'ParentModule',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

export const childContainer = defineBuilderConfig({
  name: 'ChildModule',
  useContainer: parentContainer,  // ✅ Reference to parent
  injections: [
    { token: UserService }  // Can resolve ILogger from parent
  ]
});
```

## Best Practices

### ✅ Do: Always Use the `name` Field

```typescript
// ✅ GOOD
export const userContainer = defineBuilderConfig({
  name: 'UserModule',  // Explicit, stable, readable
  injections: [/* ... */]
});
```

```typescript
// ⚠️ AVOID
export const userContainer = defineBuilderConfig({
  // No name - generates hash
  injections: [/* ... */]
});
```

### ✅ Do: Use Descriptive Names

```typescript
// ✅ GOOD - Clear purpose
export const userContainer = defineBuilderConfig({
  name: 'UserModule',
  injections: [/* ... */]
});

export const authContainer = defineBuilderConfig({
  name: 'AuthModule',
  injections: [/* ... */]
});
```

```typescript
// ❌ BAD - Generic names
export const container1 = defineBuilderConfig({
  name: 'Container1',
  injections: [/* ... */]
});

export const container2 = defineBuilderConfig({
  name: 'Container2',
  injections: [/* ... */]
});
```

### ✅ Do: Group Related Containers

```typescript
// di/auth.containers.ts
export const authContainer = defineBuilderConfig({ /* ... */ });
export const authTestContainer = defineBuilderConfig({ /* ... */ });

// di/user.containers.ts
export const userContainer = defineBuilderConfig({ /* ... */ });
export const userTestContainer = defineBuilderConfig({ /* ... */ });
```

### ❌ Don't: Put Too Many Containers in One File

If you have more than 5 containers in a file, consider splitting into multiple files for better readability.

## IDE Support

The LSP plugin validates each container independently and reports errors on the exact container with issues:

```typescript
export const containerA = defineBuilderConfig({
  name: 'ContainerA',
  injections: [
    { token: ServiceA }  // ❌ Error shown here
  ]
});

export const containerB = defineBuilderConfig({
  name: 'ContainerB',
  injections: [
    { token: ServiceB }  // No error indicator
  ]
});
```

Error messages include the container name:

```
[ContainerA] Missing binding: Service 'ServiceA' depends on 'ILogger',
             but no provider was registered.
```

## Troubleshooting

### Ambiguous error messages with duplicate `name`

**Symptom**: An error like `[MyContainer] Service not found: X` doesn't tell you which of several same-named containers threw it.

**Cause**: Two (or more) `defineBuilderConfig()` calls share the same `name` field. This is allowed (see [Naming Is Not Validated](#naming-is-not-validated) above) — it's not a build error, just a debugging inconvenience.

**Fix**: Give each container a distinct, descriptive `name`:

```typescript
// Before — ambiguous in error messages
export const containerA = defineBuilderConfig({ name: 'MyContainer', /* ... */ });
export const containerB = defineBuilderConfig({ name: 'MyContainer', /* ... */ });

// After — unambiguous
export const containerA = defineBuilderConfig({ name: 'ContainerA', /* ... */ });
export const containerB = defineBuilderConfig({ name: 'ContainerB', /* ... */ });
```

### `defineBuilderConfig() called at runtime` / unresolved `defineBuilderConfig(` in the output

**Cause**: The call site couldn't be transformed — most commonly a bare `return defineBuilderConfig({...})` with no intermediate variable. The build now rejects this shape explicitly (`UnsupportedContainerShapeError`) instead of shipping it untransformed. See the [error reference](/api/errors#unsupported-container-shape-build-time-not-a-coded-diagnostic).

**Fix**: Assign to a `const` first: `const container = defineBuilderConfig({...}); return container;`.

## See Also

- [Basic Usage](./basic-usage.md) - Container configuration basics
- [Parent Container](./parent-container.md) - Using `useContainer`
- [Partials (Modular Configuration)](./basic-usage.md#partials-modular-configuration) - Using `extends` and `definePartialConfig`
- [Generated Code](./generated-code.md) - Understanding the output
