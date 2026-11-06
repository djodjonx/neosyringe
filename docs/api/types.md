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
type Factory<T> = (context: FactoryContext) => T | PromiseLike<T>;

interface FactoryContext {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): T[];
}
```

A function that receives a limited context and returns an instance, or a promise of it. The context has `resolve` and `resolveAll` only. It is not the container. Declare what it may resolve in `dependencies` (`packages/neosyringe/src/types.ts:94` and `:103`).

<<< @/../examples/new-api/factories.ts#typed-factory

The region is compiled and run by `tests/e2e/t20-docs-examples.test.ts`. The registration lists the token the factory resolves in `dependencies`.

## Injection

```typescript
// Simplified. The real type is a union of four disjoint shapes:
// autowire, class for a token, factory, useValue.
interface Injection<T = any> {
  token: Token<T>;
  provider?: Provider<T>;
  useFactory?: boolean;
  useValue?: T;
  dependencies?: readonly DependencyRef[];
  ownership?: 'owned' | 'borrowed';
  lifecycle?: Lifecycle;
  scoped?: boolean;
  multi?: boolean;
}
```

A single injection definition (`packages/neosyringe/src/types.ts:202`):

| Property | Type | Description |
|----------|------|-------------|
| `token` | `Token<T>` | **Required**. What to register |
| `provider` | `Provider<T>` | Optional. What provides the instance |
| `useFactory` | `boolean` | Explicit factory flag |
| `lifecycle` | `Lifecycle` | `'singleton'` (default) or `'transient'` |
| `scoped` | `boolean` | If `true`, resolve locally (override parent) |
| `dependencies` | `readonly DependencyRef[]` | Tokens a factory resolves. Required in strict, even `[]` |
| `ownership` | `'owned' \| 'borrowed'` | Who closes the result. `useValue` is borrowed |

## PartialConfig

```typescript
interface PartialConfig {
  injections?: Injection[];
  expects?: Array<Token<any>>;
}
```

A reusable configuration block.

| Property | Type | Description |
|----------|------|-------------|
| `injections` | `Injection[]` | Services provided by this partial |
| `expects` | `Array<Token<any>>` | Token references expected from the host container |

The `expects` field accepts the same token expressions used in `token:` fields:
- `useInterface<T>()` for interface tokens
- A class constructor for class tokens

See [definePartialConfig](/api/functions#definepartialconfig) for usage.

## BuilderConfig

```typescript
interface BuilderConfig extends PartialConfig, BuilderCapabilities {
  name?: string;
  extends?: readonly PartialConfig[];
  useContainer?: CoreContainer | Record<string, unknown>;
}

type BuilderCapabilities = {
  optimization?: Optimization;   // open (default) or closed with roots
  runtime?: RuntimeProfile;      // { profile?: 'full' | 'minimal' }
};
```

Main configuration for a container:

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Container name (for debugging) |
| `injections` | `Injection[]` | List of injections |
| `extends` | `PartialConfig[]` | Inherit from partials |
| `useContainer` | `CoreContainer \| Record<string, unknown>` | Parent container |
| `optimization` | `Optimization` | `{ mode: 'open' }` (default) or `{ mode: 'closed', roots, eager? }`. See [From Open to Closed](/guide/closed-mode) |
| `runtime` | `RuntimeProfile` | `{ profile: 'full' \| 'minimal' }`. See [Profiles](/guide/profiles) |

## CoreContainer and Container

Two profiles, two types (`packages/neosyringe/src/types.ts:18` and `:53`):

```typescript
interface CoreContainer {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): T[];
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  createScope(): this;
}

interface Container extends CoreContainer {
  override<T>(token: Token<T>, factory: () => T): Promise<void>;
  clearOverrides(): Promise<void>;
  on(
    event: 'resolve',
    listener: (token: Token<unknown>, instance: unknown) => void,
  ): () => void;
}

type ContainerFor<C> = C extends { runtime: { profile: 'minimal' } } ? CoreContainer : Container;
```

`defineBuilderConfig` returns `ContainerFor<C>`: a `Container` by default, a `CoreContainer` with `runtime: { profile: 'minimal' }`. `AsyncContainer` is a deprecated alias that adds nothing to `CoreContainer`.

| Method | Meaning |
|--------|---------|
| `resolve` | One instance. Throws `NEO_NOT_INITIALIZED` before `initialize()` when the graph has async work. |
| `resolveAll` | A new array with every `multi: true` contribution. |
| `initialize` | Brings async singletons to ready. Immediate when there is nothing to start. |
| `destroy` | Final and idempotent. Closes the singletons this container owns. |
| `createScope` | A new container with empty caches and the same parents. |
| `override`, `clearOverrides` | Full profile, `testOverrides: true` builds only. Awaited. Reset all caches. |
| `on` | Full profile. Fires on every successful single `resolve`. Returns an unsubscribe function. |

See [States, Scopes and Ownership](/guide/states-and-ownership) and [Profiles](/guide/profiles).

### resolve\<T\>(token: Token\<T\>): T

Resolve a service by its token. The return type is inferred from the token:

```typescript
const userService = container.resolve(UserService);                            // UserService
const logger = container.resolve(useInterface<ILogger>());                     // ILogger
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl'));   // string
```
