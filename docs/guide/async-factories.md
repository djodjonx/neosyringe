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

- Every container has `initialize(): Promise<void>` (`packages/neosyringe/src/types.ts:36`). A container with no async work returns at once. You can call it everywhere without checking.
- It builds the async singletons, in dependency order, and waits for each one before its consumers run. A factory that needs another async service lists it in `dependencies`.
- Two `initialize()` calls at the same time share the work. A factory does not run twice.
- A child of an async parent needs `await child.initialize()` too: it readies the parent as well. Without it, the child's `resolve()` throws `NEO_NOT_INITIALIZED`.
- In an **open** container, `initialize()` starts every async singleton you registered. In a [closed](./closed-mode.md) container it starts the ones the roots need, and those listed in `eager`.

## When initialization fails

`initialize()` first rolls back. The owned instances built during the failed attempt are disposed in reverse order of construction. Borrowed instances are left alone (`packages/core/src/generator/LifecycleEmitter.ts:209` to `:222`). Then it rejects, in one of two ways:

- With the factory's own error, when every `dispose` succeeded.
- With a new `Error` when a `dispose` threw. It has the same message, a `cause` (the factory's error) and `cleanupErrors` (the errors thrown by `dispose`). The rollback does not stop at the first failing `dispose` (`packages/core/src/generator/LifecycleEmitter.ts:227` to `:232`).

The container is then failed:

- another `initialize()` rejects with that same error (or wrapper),
- `resolve()` throws `NEO_CONTAINER_FAILED`,
- `createScope()` throws `NEO_CONTAINER_FAILED` (`packages/core/src/generator/LifecycleEmitter.ts:294` to `:296` for a container with async work, `:303` to `:305` without),
- nothing is retried by itself.

A failed container cannot be repaired. To try again, build a new container. Or keep a root container that never ran `initialize()`, take your scopes from it, and drop a scope that failed: the root stays usable. See [States, Scopes and Ownership](./states-and-ownership.md).

`tests/e2e/t20-docs-examples.test.ts` runs all of this: the rollback order, the wrapper with `cause` and `cleanupErrors`, `NEO_CONTAINER_FAILED` on `resolve()` and `createScope()`, and a second scope that succeeds after the first failed.

## Constraints

::: warning Singleton only
An async factory cannot be `lifecycle: 'transient'`. The build fails with `NEO_ASYNC_TRANSIENT`: a transient is created on each `resolve()`, which would have to be async.
:::

- `AsyncContainer` is a deprecated alias of `CoreContainer` and adds no method (`packages/neosyringe/src/types.ts:309`). Use `CoreContainer`, or let the type come from `defineBuilderConfig`.

## Overrides are awaited too

In a test build (plugin option `testOverrides: true`), `override` and `clearOverrides` return promises. Await them before the next `resolve()`. After a reconfiguration of an async container, call `await container.initialize()` again before you resolve:

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

::: warning Build-time check on scope variables
With the default `validation: 'strict'`, `scope.resolve(...)` on the result of `createScope()` fails the build with `NEO_UNKNOWN_CONTAINER`. See [States, Scopes and Ownership](./states-and-ownership.md#scopes).
:::
