# Async Factories

Start async services (databases, HTTP clients, remote config) once at startup. After that, every `resolve()` stays synchronous.

## The rule

1. Declare the factory. It may be `async` and it declares its `dependencies`.
2. Call `await container.initialize()` once, before the first `resolve()`.
3. Resolve synchronously everywhere else.
4. Call `await container.destroy()` at shutdown.

A `resolve()` before `initialize()` finishes throws `NEO_NOT_INITIALIZED`. `run()` in `examples/new-api/async.ts` makes that call on purpose, inside a `try`, and keeps the error. The container it uses is:

<<< @/../examples/new-api/async.ts#container

```typescript
// main.ts — the only place with await
await container.initialize();

// everywhere else — fully synchronous
const client = container.resolve(clientToken);

// at shutdown
await container.destroy();
```

`tests/e2e/t20-docs-examples.test.ts` runs `examples/new-api/async.ts`. It checks the early error (`NEO_NOT_INITIALIZED`), the value after `initialize()`, one `dispose` call at `destroy()`, and `NEO_CONTAINER_DESTROYED` afterwards.

## What initialize does

- Every container has `initialize(): Promise<void>` (`packages/neosyringe/src/types.ts:67`). A container with no async work returns at once. You can call it everywhere without checking.
- It builds the async singletons, in dependency order, and waits for each one before its consumers run. A factory that needs another async service lists it in `dependencies`. One at a time by default; [`initialization.concurrency`](#starting-async-services-at-the-same-time) lets independent ones start together.
- Two `initialize()` calls at the same time share the work. A factory does not run twice.
- A child of an async parent needs `await child.initialize()` too: it readies the parent as well. Without it, the child's `resolve()` throws `NEO_NOT_INITIALIZED`.
- In an **open** container, `initialize()` starts every async singleton you registered. In a [closed](./closed-mode.md) container it starts the ones the roots need, and those listed in `eager`.

## Starting async services at the same time

`initialize()` builds the async singletons one after the other. `initialization: { concurrency: N }` on the builder lets up to `N` of them run at once. It is opt-in: with `N` above 1, independent services may finish in another order than they were declared.

```typescript
export const container = defineBuilderConfig({
  name: 'App',
  initialization: { concurrency: 4 },
  injections: [
    { token: databaseToken, useFactory: true, dependencies: [], provider: async () => openDatabase() },
    { token: cacheToken, useFactory: true, dependencies: [], provider: async () => openCache() },
  ],
});
```

- **A literal of the builder.** `N` is a positive integer literal, read when the plugin builds the container (`packages/core/src/analyzer/parsers/ConfigParser.ts:215`). `0`, a negative number, `1.5`, a variable, a string, a spread member or a computed member is `NEO_CONFIG_UNSUPPORTED`, reported at that value (`packages/core/src/analyzer/parsers/ConfigParser.ts:251`). It is not an argument of `initialize()`, and a partial that declares it is refused (`packages/core/src/analyzer/collectors/ConfigCollector.ts:927`). The type is `InitializationOptions` (`packages/neosyringe/src/types.ts:232`).
- **The default is 1.** With no option, or `concurrency: 1`, `initialize()` is written as it was before, text for text (`packages/core/src/generator/LifecycleEmitter.ts:335`). So is a container with fewer than two async steps (`packages/core/src/generator/LifecycleEmitter.ts:337`). `N` is capped to the number of steps (`packages/core/src/generator/LifecycleEmitter.ts:395`).
- **A step waits for every async step it needs.** There is one step per async singleton and per async `multi` contribution. A step starts when every step it reaches has finished, also when it reaches it through a sync factory or class, a `multi` token it reads with `resolveAll`, or an alias (`packages/core/src/generator/LifecycleEmitter.ts:328`). The `dependencies` of a factory are part of that graph (`packages/core/src/analyzer/shared/registrationGraph.ts:90`, `packages/core/src/analyzer/graphAdapter.ts:450`). Steps start in the order a sequential initialization would run them.
- **An opaque factory waits for every earlier step.** A factory with no `dependencies` list (`validation: 'compatible'`, an opaque factory: `packages/core/src/analyzer/types.ts:231`) declares nothing, so the build cannot tell which steps it resolves. Its step, and the step of a registration that reads one through a sync factory or class, starts only when every step that comes before it in the sequential order has finished (`packages/core/src/generator/LifecycleEmitter.ts:319` to `:323`). The emitted list names only the nearest earlier step that waits the same way and the steps after it, because that step already waits for every step before it; a container whose factories are all opaque writes one dependency per step (`packages/core/src/generator/LifecycleEmitter.ts:385` to `:390`). A step that comes after it and does not reach it is not held back. This keeps the order safe but gives up the overlap for that step: list its `dependencies` to get it back. Closed mode refuses an opaque factory (`packages/core/src/analyzer/parsers/ConfigParser.ts:460`).
- **Parents and eager roots keep their place.** The `useContainer` parents are initialized first, one after the other, then the parents are checked once more (`packages/core/src/generator/LifecycleEmitter.ts:533`, `packages/core/src/generator/LifecycleEmitter.ts:501`). The `eager` roots run after the last step (`packages/core/src/generator/LifecycleEmitter.ts:538`).
- **A cycle is refused before anything runs.** Steps that wait for each other make `generate()` throw, at build time (`packages/core/src/generator/LifecycleEmitter.ts:402`).

### When a concurrent initialization fails

After the first failure no new step starts. The steps already started are waited for, then the rollback runs as described below (`packages/core/src/generator/LifecycleEmitter.ts:485` to `:488`). A step that finishes after the failure is rolled back too: its owned value is disposed once.

- **One failure** rejects with that same error object, as with `N = 1` (`packages/core/src/generator/LifecycleEmitter.ts:489`).
- **Two or more failures** reject with an `AggregateError`. Its message is `initialization failed`, its `errors` are the failures in the order they happened, and its `cause` is the first one (`packages/core/src/generator/LifecycleEmitter.ts:490` to `:493`). This is the one difference from `N = 1`, where only the first factory that fails runs. Code that tests `error instanceof` a factory's own error type must look at `error.cause` when it opts in.

A promise that is still pending cannot be cancelled. The container waits for the real end of every started factory before it rolls back, so a slow factory delays the rejection. Cooperative cancellation with a signal is not part of this option.

`tests/bench/init-cost.mjs` measures the scheduling time and the heap of a container with 10000 async steps. This page quotes no result from it.

## When initialization fails

`initialize()` first rolls back. The owned instances built during the failed attempt are disposed in reverse order of construction, with the same rules as `destroy()`: `dispose()`, else `[Symbol.asyncDispose]()`, else `[Symbol.dispose]()`, and a promise the method returns is awaited (see [Disposable Services](./disposable.md#standard-protocols)). Borrowed instances are left alone (`packages/core/src/generator/LifecycleEmitter.ts:564` to `:567`). Then it rejects, in one of two ways:

- With the factory's own error, when every `dispose` succeeded.
- With a new `Error` when a `dispose` threw. It has the same message, a `cause` (the factory's error) and `cleanupErrors` (the errors thrown by `dispose`). The rollback does not stop at the first failing `dispose` (`packages/core/src/generator/LifecycleEmitter.ts:569` to `:578`).

The container is then failed:

- another `initialize()` rejects with that same error (or wrapper),
- `resolve()` throws `NEO_CONTAINER_FAILED`,
- `createScope()` throws `NEO_CONTAINER_FAILED` (`packages/core/src/generator/LifecycleEmitter.ts:650` to `:652` for a container with async work, `:660` to `:662` without),
- nothing is retried by itself.

A failed container cannot be repaired. To try again, build a new container. Or keep a root container that never ran `initialize()`, take your scopes from it, and drop a scope that failed: the root stays usable. See [States, Scopes and Ownership](./states-and-ownership.md).

`tests/e2e/t20-docs-examples.test.ts` runs all of this: the rollback order, the wrapper with `cause` and `cleanupErrors`, `NEO_CONTAINER_FAILED` on `resolve()` and `createScope()`, and a second scope that succeeds after the first failed.

## Constraints

::: warning Singleton only
An async factory cannot be `lifecycle: 'transient'`. The build fails with `NEO_ASYNC_TRANSIENT`: a transient is created on each `resolve()`, which would have to be async.
:::

- `AsyncContainer` is a deprecated alias of `CoreContainer` and adds no method (`packages/neosyringe/src/types.ts:555`). Use `CoreContainer`, or let the type come from `defineBuilderConfig`.

## Overrides are awaited too

In a test build (plugin option `testOverrides: true`), `override`, `overrideMany` and `clearOverrides` return promises. Await them before the next `resolve()`. After a reconfiguration of an async container, call `await container.initialize()` again before you resolve:

```typescript
await container.override(clientToken, () => fakeClient);
await container.initialize();
const client = container.resolve(clientToken); // fakeClient
await container.clearOverrides();
await container.initialize();
```

The override factory is synchronous and its result is borrowed: the container does not close it. See [profiles](./profiles.md).

## Testing

`destroy()` is final. After it, `initialize()` and `resolve()` throw `NEO_CONTAINER_DESTROYED`. Give each test its own scope:

```typescript
let scope: CoreContainer;
beforeEach(async () => {
  scope = container.createScope();
  await scope.initialize();
});
afterEach(async () => {
  await scope.destroy();
});
```

`scope.resolve(...)` is checked against the container that `createScope()` came from when the build can tell which container it is; otherwise `NEO_UNKNOWN_CONTAINER` (`packages/core/src/analyzer/collectors/resolutionUsages.ts:149`, `packages/core/src/analyzer/validators/MissingDependencyValidator.ts:136`). See [States, Scopes and Ownership](./states-and-ownership.md#scopes).
