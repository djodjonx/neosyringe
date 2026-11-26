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
  resolveMany<const T extends readonly Token<unknown>[]>(tokens: T): ValuesOf<T>;
}
```

A function that receives a limited context and returns an instance, or a promise of it. The context has `resolve`, `resolveAll` and `resolveMany` only. It is not the container. Declare what it may resolve in `dependencies` (`packages/neosyringe/src/types.ts:187` and `:202`).

<<< @/../examples/new-api/factories.ts#typed-factory

The region is compiled and run by `tests/e2e/t20-docs-examples.test.ts`. The registration lists the token the factory resolves in `dependencies`.

## Injection

```typescript
// Simplified. The real type is a union of five disjoint shapes:
// autowire, class for a token, factory, useValue, alias.
interface Injection<T = any> {
  token: Token<T>;
  provider?: Provider<T>;
  useFactory?: boolean;
  useValue?: T;
  useExisting?: Token<T>;
  dependencies?: readonly DependencyRef[];
  ownership?: 'owned' | 'borrowed';
  lifecycle?: Lifecycle;
  scoped?: boolean;
  multi?: boolean;
}
```

A single injection definition (`packages/neosyringe/src/types.ts:390`):

| Property | Type | Description |
|----------|------|-------------|
| `token` | `Token<T>` | **Required**. What to register |
| `provider` | `Provider<T>` | Optional. What provides the instance |
| `useFactory` | `boolean` | Explicit factory flag |
| `lifecycle` | `Lifecycle` | `'singleton'` (default) or `'transient'` |
| `scoped` | `boolean` | If `true`, resolve locally (override parent) |
| `dependencies` | `readonly DependencyRef[]` | Tokens a factory resolves. Required in strict, even `[]` |
| `ownership` | `'owned' \| 'borrowed'` | Who closes the result. `useValue` is borrowed |
| `useExisting` | `Token<T>` | Makes the registration an alias of another token. Carries no `provider`, `useFactory`, `useValue`, `lifecycle`, `ownership`, `dependencies` or `multi`; `scoped` is allowed. See [aliases](../guide/aliases.md) |

## Alias

```typescript
type Alias<T extends Token<unknown>, U extends Token<unknown>> = {
  readonly token: T;
  readonly useExisting: U;
  readonly scoped?: boolean;
  // provider, useFactory, useValue, lifecycle, ownership, multi and dependencies: never
} & ([ValueOf<U>] extends [ValueOf<T>] ? unknown : never);
```

The shape of an alias registration, and the check the `injections` list applies to every `useExisting` (`packages/neosyringe/src/types.ts:348`, `packages/neosyringe/src/types.ts:455`). The pair is valid when the value of the target is assignable to the value of the token: a class instance, the `T` of `useInterface<T>()`. A subtype is accepted, a wrong type is a type error on the registration, and `Alias<typeof Service, typeof Other>` is `never` when `Other` has not the value of `Service`. The build checks the same relation with the checker, because the structure of two interfaces does not tell them apart at run time.

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
  scopeInputs?: readonly InputToken[];
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
| `scopeInputs` | `readonly InputToken[]` | The values each scope is given: a literal list of `useInterface<T>()` and `useProperty(...)` tokens. The builder then returns a `ContainerTemplate`. See [ContainerTemplate and BoundContainer](#containertemplate-and-boundcontainer) |
| `extends` | `PartialConfig[]` | Inherit from partials |
| `useContainer` | `CoreContainer \| Record<string, unknown>` | Parent container |
| `optimization` | `Optimization` | `{ mode: 'open' }` (default) or `{ mode: 'closed', roots, eager? }`. See [From Open to Closed](/guide/closed-mode) |
| `runtime` | `RuntimeProfile` | `{ profile: 'full' \| 'minimal' }`. See [Profiles](/guide/profiles) |

## CoreContainer and Container

Two profiles, two types (`packages/neosyringe/src/types.ts:29` and `:86`):

```typescript
interface CoreContainer {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): T[];
  resolveMany<const T extends readonly Token<unknown>[]>(tokens: T): ValuesOf<T>;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  createScope(): this;
}

interface Container extends CoreContainer {
  override<T>(token: Token<T>, factory: () => T): Promise<void>;
  overrideMany<const E extends readonly OverrideEntry[]>(entries: E & OverrideGuard<E>): Promise<void>;
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
| `resolveMany` | The values of several tokens as a tuple, in the order of the tokens, resolved one by one like `resolve`. The first error stops the batch. |
| `initialize` | Brings async singletons to ready. Immediate when there is nothing to start. |
| `destroy` | Final and idempotent. Closes the singletons this container owns. |
| `[Symbol.asyncDispose]` | Calls `destroy()`, so a container and a scope are `await using` resources. Typed only when the consumer's lib declares `Symbol.asyncDispose` (`AsyncDisposalMembers`, `packages/neosyringe/src/types.ts:21-23`); it is on `CoreContainer`, `Container`, `ContainerTemplate` and every scope. See [Disposable Services](/guide/disposable#await-using). |
| `createScope` | A new container with empty caches and the same parents. |
| `override`, `clearOverrides` | Full profile, `testOverrides: true` builds only. Awaited. Reset all caches. |
| `overrideMany` | Full profile, `testOverrides: true` builds only. Awaited. The whole batch is checked first, then one transition (one cleanup pass) installs every mock. A refused batch changes nothing. Refusals: `NEO_OVERRIDE_DUPLICATE`, `NEO_OVERRIDE_INVALID`, `NEO_OVERRIDE_MULTI_UNSUPPORTED`, `NEO_CONTAINER_BUSY`, `NEO_CONTAINER_DESTROYED`, `NEO_CONTAINER_FAILED`, `NEO_TEST_API_DISABLED`. A factory that returns another type than its token is a compile error (`OverrideGuard`, `packages/neosyringe/src/types.ts:173`). |
| `on` | Full profile. Fires on every successful single `resolve`. Returns an unsubscribe function. |

See [States, Scopes and Ownership](/guide/states-and-ownership) and [Profiles](/guide/profiles).

## ContainerTemplate and BoundContainer

A builder with a literal, non-empty `scopeInputs` is the model of its scopes, not a container that resolves (`ContainerFor`, `packages/neosyringe/src/types.ts:278`). An empty list is no input: the builder is a `Container` or a `CoreContainer` as before (`packages/neosyringe/src/types.ts:267`).

```typescript
type Profile = 'full' | 'minimal';

interface ContainerTemplate<I extends readonly InputToken[], P extends Profile> {
  createScope<const E extends readonly InputEntry[]>(...args: ScopeArguments<I, E>): BoundContainer<I, P>;
  destroy(): Promise<void>;
}

// What createScope answers: the API of the profile, except that createScope asks for values again.
type BoundContainer<I extends readonly InputToken[] = readonly [], P extends Profile = 'full'> =
  BoundCore<I, P> & (P extends 'full' ? FullMembers : unknown);
```

`Profile`, `ContainerTemplate` and `BoundContainer` are at `packages/neosyringe/src/types.ts:231`, `:260` and `:252`. `BoundCore` and `FullMembers` (`packages/neosyringe/src/types.ts:240` and `:234`) are not exported: they only name what the two profiles share.

```typescript
const requests = defineBuilderConfig({
  scopeInputs: [requestToken, retries],
  injections: [{ token: Handler }],
});
const scope = requests.createScope({
  values: [
    { token: retries, useValue: 3 },                       // any order
    { token: requestToken, useValue: { id: 'r1' } },
  ],
});
scope.resolve(requestToken);    // the object you gave, not a copy
requests.resolve(requestToken); // does not compile: the template has no resolve
```

- **Every input, once.** With a list written inline, a missing, an extra or a wrong-type value does not compile, and neither does a union of pairs one of which is incoherent (`InputGuard` checks each pair as a unit, `packages/neosyringe/src/types.ts:148` and `:157`). A widened `readonly` array is checked pair by pair only: a pair that names a token with the wrong value type does not compile, but the checker does not count the entries, so a missing or a repeated entry compiles and is refused at run time with `NEO_SCOPE_INPUT_MISSING` or `NEO_SCOPE_INPUT_DUPLICATE`.
- **The checker cannot see identity.** Two interfaces with the same members have the same token type for the checker. Giving one for the other compiles; `createScope` refuses it at run time with `NEO_SCOPE_INPUT_MISSING` or `NEO_SCOPE_INPUT_UNKNOWN`. A token given twice is `NEO_SCOPE_INPUT_DUPLICATE` at run time too. See [errors](./errors.md#thrown-at-run-time-by-the-generated-container).
- **The list is a literal.** A `scopeInputs` the checker cannot count (`readonly InputToken[]`, or an optional member) is rejected, like a profile that is not a literal (`packages/neosyringe/src/types.ts:324`). A class token is not an `InputToken`.
- **No partial.** `scopeInputs` is not a member of `PartialConfig` (`packages/neosyringe/src/types.ts:477`): `definePartialConfig({ scopeInputs })` is a type error (TS2353), and the build says `NEO_CONFIG_UNSUPPORTED` if it is reached from untyped code. A builder that extends a partial declares the inputs itself, and a partial that needs one lists it in `expects`.
- **Not a parent.** `useContainer` takes a `CoreContainer` or a plain record (`packages/neosyringe/src/types.ts:529`). A template or a bound scope is neither, so it is refused as a parent.
- **The model, untyped.** Called from JavaScript, the model's `resolve`, `resolveAll`, `resolveMany` and `initialize` throw `NEO_SCOPE_INPUTS_UNBOUND`. On the program the plugin rewrites, the exported container is typed by the generated class, which does have those members: the typed contract holds on the source program, and the run-time refusal holds everywhere.
- **Values are borrowed.** `destroy()` of a scope disposes the singletons the scope owns, never a value it was given: an input is a borrowed `value` (`packages/core/src/generator/ResolveEmitter.ts:54` to `:54`) and has no disposal slot (`packages/core/src/generator/LifecycleEmitter.ts:536` to `:540`). See [states and ownership](/guide/states-and-ownership#scope-inputs).

### resolve\<T\>(token: Token\<T\>): T

Resolve a service by its token. The return type is inferred from the token:

```typescript
const userService = container.resolve(UserService);                            // UserService
const logger = container.resolve(useInterface<ILogger>());                     // ILogger
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl'));   // string
```
