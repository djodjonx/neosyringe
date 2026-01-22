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

## Container ID Generation

Each container needs a **unique ID** to generate distinct class names. The ID is determined by:

### Priority 1: The `name` Field

**Recommended**: Use the `name` field for explicit control.

```typescript
export const myContainer = defineBuilderConfig({
  name: 'UserModule',  // ← This becomes the container ID
  injections: [/* ... */]
});

// Generates: class NeoContainer_UserModule { ... }
```

### Priority 2: Hash-Based ID

If no `name` field is provided, a stable hash is generated:

```typescript
export const container = defineBuilderConfig({
  // No name field
  injections: [/* ... */]
});

// Generates: class NeoContainer_a1b2c3d4 { ... }
```

⚠️ **Warning**: Hash-based IDs may change if the config content changes. Always prefer using the `name` field.

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

```typescript
// containers.ts (after build)
import * as Import_0 from './containers';

// ✨ Unique class for UserModule
class NeoContainer_UserModule {
  private instances = new Map<any, any>();

  private create_UserService(): any {
    return new Import_0.UserService();
  }

  constructor(
    private parent?: any,
    private name: string = 'UserModule'
  ) {}

  public resolve(token: any): any {
    // ... resolution logic
  }
}

export const userContainer = new NeoContainer_UserModule();

// ✨ Unique class for ProductModule
class NeoContainer_ProductModule {
  private instances = new Map<any, any>();

  private create_ProductService(): any {
    return new Import_0.ProductService();
  }

  constructor(
    private parent?: any,
    private name: string = 'ProductModule'
  ) {}

  public resolve(token: any): any {
    // ... resolution logic
  }
}

export const productContainer = new NeoContainer_ProductModule();
```

## Validation Rules

### ✅ Allowed: Different Names in Same File

```typescript
export const containerA = defineBuilderConfig({
  name: 'ModuleA',
  injections: [/* ... */]
});

export const containerB = defineBuilderConfig({
  name: 'ModuleB',
  injections: [/* ... */]
});
// ✅ OK - Different names
```

### ✅ Allowed: Same Name in Different Files

```typescript
// file1.ts
export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [/* ... */]
});

// file2.ts
export const container = defineBuilderConfig({
  name: 'AppContainer',  // ✅ OK - Different file
  injections: [/* ... */]
});
```

### ❌ Error: Duplicate Names in Same File

```typescript
export const containerA = defineBuilderConfig({
  name: 'MyContainer',
  injections: [/* ... */]
});

export const containerB = defineBuilderConfig({
  name: 'MyContainer',  // ❌ ERROR!
  injections: [/* ... */]
});

// Error: Duplicate container name 'MyContainer' found in containers.ts.
// Each container must have a unique 'name' field within the same file.
```

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

### Error: Duplicate container name

**Problem**: Two containers have the same `name` in the same file.

**Solution**: Use unique names for each container:

```typescript
// ❌ Before
export const containerA = defineBuilderConfig({ name: 'MyContainer', /* ... */ });
export const containerB = defineBuilderConfig({ name: 'MyContainer', /* ... */ });

// ✅ After
export const containerA = defineBuilderConfig({ name: 'ContainerA', /* ... */ });
export const containerB = defineBuilderConfig({ name: 'ContainerB', /* ... */ });
```

### Class name collisions in generated code

**Problem**: Two containers generate the same class name.

**Cause**: Same `name` field or hash collision.

**Solution**: Always use explicit, unique `name` fields.

## See Also

- [Basic Usage](./basic-usage.md) - Container configuration basics
- [Parent Container](./parent-container.md) - Using `useContainer`
- [Partial Configs](./parent-container.md#partial-configurations) - Using `extends`
- [Generated Code](./generated-code.md) - Understanding the output
