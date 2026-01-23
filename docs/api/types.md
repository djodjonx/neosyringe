# Types

Type definitions for NeoSyringe.

## Lifecycle

```typescript
type Lifecycle = 'singleton' | 'transient';
```

Defines how instances are managed:

| Value | Description |
|-------|-------------|
| `singleton` | One instance per container (default) |
| `transient` | New instance on every `resolve()` |

## Constructor

```typescript
type Constructor<T = unknown> = new (...args: unknown[]) => T;
```

Represents any class constructor.

## Token

```typescript
type Token<T = any> = Constructor<T> | InterfaceToken<T> | PropertyToken<T, any>;
```

A token that can be resolved by the container:

- **Constructor**: A class reference (e.g., `UserService`)
- **InterfaceToken**: Created by `useInterface<T>()`
- **PropertyToken**: Created by `useProperty<T>(Class, 'param')`

## InterfaceToken

```typescript
type InterfaceToken<T> = {
  __brand: 'InterfaceToken';
  __type: T;
};
```

A compile-time token for interfaces. Created by `useInterface<T>()`.

::: warning Internal Type
You don't create this directly. Use `useInterface<T>()` instead.
:::

## PropertyToken

```typescript
type PropertyToken<T, C = unknown> = {
  __brand: 'PropertyToken';
  __type: T;
  __class: C;
  __name: string;
};
```

A token for primitive values bound to a specific class parameter. Created by `useProperty<T>(Class, 'param')`.

## Provider

```typescript
type Provider<T> = Constructor<T> | Factory<T>;
```

What creates instances:

- **Constructor**: A class to instantiate
- **Factory**: A function that creates the instance

## Factory

```typescript
type Factory<T> = (container: Container) => T;
```

A function that receives the container and returns an instance.

```typescript
const myFactory: Factory<IConfig> = (container) => ({
  apiUrl: process.env.API_URL,
  logger: container.resolve(useInterface<ILogger>())
});
```

## Injection

```typescript
interface Injection<T = any> {
  token: Token<T>;
  provider?: Provider<T>;
  useFactory?: boolean;
  lifecycle?: Lifecycle;
  scoped?: boolean;
}
```

A single injection definition:

| Property | Type | Description |
|----------|------|-------------|
| `token` | `Token<T>` | **Required**. What to register |
| `provider` | `Provider<T>` | Optional. What provides the instance |
| `useFactory` | `boolean` | Explicit factory flag |
| `lifecycle` | `Lifecycle` | `'singleton'` (default) or `'transient'` |
| `scoped` | `boolean` | If `true`, resolve locally (override parent) |

## PartialConfig

```typescript
interface PartialConfig {
  injections?: Injection[];
}
```

A reusable configuration block.

## BuilderConfig

```typescript
interface BuilderConfig extends PartialConfig {
  name?: string;
  extends?: PartialConfig[];
  useContainer?: any;
}
```

Main configuration for a container:

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Container name (for debugging) |
| `injections` | `Injection[]` | List of injections |
| `extends` | `PartialConfig[]` | Inherit from partials |
| `useContainer` | `any` | Parent container |

## Container

```typescript
interface Container {
  resolve<T>(token: Token<T>): T;
}
```

The generated container interface.

### resolve\<T\>(token: Token\<T\>): T

Resolve a service by its token. The return type is automatically inferred from the token.

**Type Safety**: TypeScript infers the correct type based on the token:

```typescript
// Resolving a class - returns the class type
const userService = container.resolve(UserService);
// Type: UserService ✅

// Resolving an interface - returns the interface type
const logger = container.resolve(useInterface<ILogger>());
// Type: ILogger ✅

// Resolving a property - returns the property type
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl'));
// Type: string ✅
```

**Benefits**:
- ✨ Full auto-completion in your IDE
- 🛡️ Compile-time type checking
- 📝 No type assertions needed

::: tip Zero Runtime Overhead
The generated container uses the generic `<T>` for type inference only. At runtime, it's just a fast switch statement!
:::

