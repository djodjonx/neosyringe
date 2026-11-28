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

- Every container has `initialize(options?: InitializeOptions): Promise<void>` (`packages/neosyringe/src/types.ts:163`). A container with no async work returns at once. You can call it everywhere without checking.
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

- **A literal of the builder.** `N` is a positive integer literal, read when the plugin builds the container (`packages/core/src/analyzer/parsers/ConfigParser.ts:215`). `0`, a negative number, `1.5`, a variable, a string, a spread member or a computed member is `NEO_CONFIG_UNSUPPORTED`, reported at that value (`packages/core/src/analyzer/parsers/ConfigParser.ts:251`). It is not an argument of `initialize()`, and a partial that declares it is refused (`packages/core/src/analyzer/collectors/ConfigCollector.ts:927`). The type is `InitializationOptions` (`packages/neosyringe/src/types.ts:350`).
- **The default is 1.** With no option, or `concurrency: 1`, `initialize()` is written exactly as it is with no option, and its steps run in the order they always had (`packages/core/src/generator/LifecycleEmitter.ts:350`). So is a container with fewer than two async steps (`packages/core/src/generator/LifecycleEmitter.ts:352`). `N` is capped to the number of steps (`packages/core/src/generator/LifecycleEmitter.ts:410`).
- **A step waits for every async step it needs.** There is one step per async singleton and per async `multi` contribution. A step starts when every step it reaches has finished, also when it reaches it through a sync factory or class, a `multi` token it reads with `resolveAll`, or an alias (`packages/core/src/generator/LifecycleEmitter.ts:342`). The `dependencies` of a factory are part of that graph (`packages/core/src/analyzer/shared/registrationGraph.ts:90`, `packages/core/src/analyzer/graphAdapter.ts:450`). Steps start in the order a sequential initialization would run them.
- **An opaque factory waits for every earlier step.** A factory with no `dependencies` list (`validation: 'compatible'`, an opaque factory: `packages/core/src/analyzer/types.ts:231`) declares nothing, so the build cannot tell which steps it resolves. Its step, and the step of a registration that reads one through a sync factory or class, starts only when every step that comes before it in the sequential order has finished (`packages/core/src/generator/LifecycleEmitter.ts:333` to `:337`). The emitted list names only the nearest earlier step that waits the same way and the steps after it, because that step already waits for every step before it; a container whose factories are all opaque writes one dependency per step (`packages/core/src/generator/LifecycleEmitter.ts:400` to `:405`). A step that comes after it and does not reach it is not held back. This keeps the order safe but gives up the overlap for that step: list its `dependencies` to get it back. Closed mode refuses an opaque factory (`packages/core/src/analyzer/parsers/ConfigParser.ts:460`).
- **Parents and eager roots keep their place.** The `useContainer` parents are initialized first, one after the other, then the parents are checked once more (`packages/core/src/generator/LifecycleEmitter.ts:568`, `packages/core/src/generator/LifecycleEmitter.ts:521`). The `eager` roots run after the last step (`packages/core/src/generator/LifecycleEmitter.ts:580`).
- **A cycle is refused before anything runs.** Steps that wait for each other make `generate()` throw, at build time (`packages/core/src/generator/LifecycleEmitter.ts:417`).

### When a concurrent initialization fails

After the first failure no new step starts. The steps already started are waited for, then the rollback runs as described below (`packages/core/src/generator/LifecycleEmitter.ts:504` to `:507`). A step that finishes after the failure is rolled back too: its owned value is disposed once.

- **One failure** rejects with that same error object, as with `N = 1` (`packages/core/src/generator/LifecycleEmitter.ts:508`).
- **Two or more failures** reject with an `AggregateError`. Its message is `initialization failed`, its `errors` are the failures in the order they happened, and its `cause` is the first one (`packages/core/src/generator/LifecycleEmitter.ts:509` to `:512`). This is the one difference from `N = 1`, where only the first factory that fails runs. Code that tests `error instanceof` a factory's own error type must look at `error.cause` when it opts in.

A promise that is still pending cannot be cancelled by the container. It waits for the real end of every started factory before it rolls back, so a slow factory delays the rejection. A factory can be asked to stop with a signal: see [Cancelling an initialization](#cancelling-an-initialization).

`tests/bench/init-cost.mjs` measures the scheduling time and the heap of a container with 10000 async steps. This page quotes no result from it.

## Cancelling an initialization

`initialize({ signal })` takes the signal of an `AbortController`. It is opt-in: a call with no options behaves as it always did.

```typescript
const controller = new AbortController();
const ready = container.initialize({ signal: controller.signal });

// Later, when the caller gives up:
controller.abort(new Error('startup cancelled'));
await ready.catch((error) => {
  // `error` is the object that was passed to abort(), not a copy.
});
```

The option is `InitializeOptions`, one optional member `signal` (`packages/neosyringe/src/types.ts:41`, `packages/neosyringe/src/types.ts:50`). Its type is `AbortSignalLike` (`packages/neosyringe/src/types.ts:30`), the members of an `AbortSignal` that the container reads, written out so the types need neither the DOM lib nor `@types/node`. A real `AbortSignal`, an `AbortSignal.timeout(ms)` and a hand-made object with the same members are all accepted (`tests/consumer-types/positive/signal.ts`, `tests/consumer-types/positive-nodom/signal.ts` with `lib: ["ES2021"]`). The generated file declares the same shape for itself and reads `AbortController` from `globalThis` when it is needed; a runtime without that global gets a stand-in with the same members (`packages/core/src/generator/signalEmitter.ts:97-122`). A listener of that stand-in that throws does not stop the others: the error is reported to the host as an unhandled rejection, and the abort goes on (`packages/core/src/generator/signalEmitter.ts:117-119`).

### What happens

- **Aborted before the start.** No factory runs, and a `useContainer` parent is not asked to initialize (`packages/core/src/generator/LifecycleEmitter.ts:561`). The promise rejects with `signal.reason` and the container ends failed with that reason as its failure: the next `initialize()` rejects with it, `resolve()` throws `NEO_CONTAINER_FAILED` with it as `cause` (`packages/core/src/generator/LifecycleEmitter.ts:622`, `packages/core/src/generator/LifecycleEmitter.ts:647`).
- **Aborted while it runs.** Two promises are kept (`packages/core/src/generator/LifecycleEmitter.ts:609`, `packages/core/src/generator/LifecycleEmitter.ts:625`). The one you wait on rejects at once with `signal.reason`, the same object (`packages/core/src/generator/LifecycleEmitter.ts:614` to `:619`). The other is the real work. It ends when the factories that were running have returned and the rollback has run. No new step starts after the abort (`packages/core/src/generator/LifecycleEmitter.ts:577`; with `concurrency` above 1, `packages/core/src/generator/LifecycleEmitter.ts:504` and `:514`). `ready` is never published.
- **A factory that honours the signal.** One that rejects when `ctx.signal` aborts, with `signal.reason` or with an error of its own, ends the work at once: the container is failed with that error as its failure, what was built before is closed once, and the promise you waited on already has `signal.reason`. With `destroy()` the factory sees a `NEO_CONTAINER_DESTROYED` reason, `destroy()` ends as soon as the factory has rejected and the close has run, and the promise of `initialize()` rejects with the factory's error.
- **A factory that ignores the signal.** It cannot be interrupted. When it finally returns, its owned value is stored and journaled like any other (`packages/core/src/generator/ResolveEmitter.ts:61`), and the rollback disposes it once. Until the work ends the container is not resolvable: `resolve()` throws `NEO_NOT_INITIALIZED`, and `createScope`, `override`, `overrideMany` and `clearOverrides` throw `NEO_CONTAINER_BUSY` (`packages/core/src/generator/LifecycleEmitter.ts:682`, `packages/core/src/generator/LifecycleEmitter.ts:780`, `packages/core/src/generator/LifecycleEmitter.ts:1143`).
- **Not a signal.** Untyped code that passes an `options.signal` that is `null`, or has no `addEventListener` and `removeEventListener`, gets a rejected `TypeError`, never a throw, and nothing starts (`packages/core/src/generator/LifecycleEmitter.ts:597`).
- **A ready container ignores a later signal.** `initialize({ signal })` on a ready container resolves, even when the signal is already aborted, and nothing is destroyed (`packages/core/src/generator/LifecycleEmitter.ts:591`). The listener on your signal is removed when the work settles, ok, failed or aborted (`packages/core/src/generator/LifecycleEmitter.ts:628`), so a signal you reuse collects no listener.

### Joining a running initialization

While an initialization runs, and also after its signal aborted while the work is still running, a second `initialize()` with no options, or with the same signal, returns the very promise the first call returned (`===`). A different signal is refused with `NEO_INIT_OPTIONS_CONFLICT`, and so is a signal passed after a first call that had none (`packages/core/src/generator/LifecycleEmitter.ts:588`). The refusal changes nothing: the first call keeps running.

```text
NEO_INIT_OPTIONS_CONFLICT: [App] initialize() is running with another signal
```

### An example that runs

One factory reads `context.signal` and one waits for it. The second container is cancelled with `controller.abort(new Error('stop'))`: `initialize()` rejects with that very error, not a copy: the example tests the rejection with `value === reason` and returns `true`, then runs the same test on a `new Error('stop')` that nobody passed to `abort()` and returns `false`. The factory saw the abort. `tests/e2e/g07-docs-examples.test.ts` compiles and runs `examples/new-api/signal.ts`.

<<< @/../examples/new-api/signal.ts#container

<<< @/../examples/new-api/signal.ts#cancel

### What a factory sees

`FactoryContext.signal` is the signal of the initialization the factory runs for (`packages/neosyringe/src/types.ts:305`). It aborts with the same reason as your signal, and with a `NEO_CONTAINER_DESTROYED` error when `destroy()` is called while the factory runs. Pass it to whatever the factory waits on:

```typescript
{ token: client, useFactory: true, dependencies: [], provider: async (ctx) => {
  const response = await fetch(url, { signal: ctx.signal });
  return new Client(await response.json());
} }
```

- A factory called outside an initialization (a sync factory resolved after `ready`) gets a signal that never aborts. It is one object, shared by every such call and by every scope of the container class (`packages/core/src/generator/signalEmitter.ts:124-126`): a listener added to it is never called and never removed. Do not add one per call, because with transient or per-scope factories they would pile up. `_neoSignal` answers it (`packages/core/src/generator/signalEmitter.ts:89-92` for a sync container, `packages/core/src/generator/signalEmitter.ts:129-138` for an async one).
- The context expires with the factory call like the rest of it: reading `signal` later throws `NEO_FACTORY_CONTEXT_EXPIRED` (the expiry check of the signal read of a declared factory is `packages/core/src/generator/factoryLeaseEmitter.ts:113-116`, and the one of an opaque factory is `packages/core/src/generator/FactoryEmitter.ts:460-463`).
- `signal` is an accessor of the prototype of the context, not an own property (`packages/core/src/generator/factoryLeaseEmitter.ts:68-79`). `ctx.signal` and `const { signal } = ctx` read it. `{ ...ctx }` does not copy it and `Object.keys(ctx)` does not list it. The context also has one own function member, `__neoRead`, which holds the expiry check and returns only the signal: it gives no access to the container. Build the context of a test double by hand, not by copying a real one.
- The signal is the signal of one initialization. Do not use it to carry data of a request.

### Destroy during an initialization

`destroy()` marks the container as closing, installs its own promise, and only then aborts the signal the factories hold, so a listener that calls `destroy()` gets the same promise and a `resolve()` from it throws `NEO_CONTAINER_DESTROYED` (`packages/core/src/generator/LifecycleEmitter.ts:1320` to `:1325`). The promise of `destroy()` resolves after the factories that were running have returned and the close has run, so a factory that ignores the signal delays it. With the default sequential initialization (no `concurrency`, or `1`) a destroy does not stop the steps that have not started: they still run and are closed with the rest, as before (`packages/core/tests/generator/t07-initialisation-runtime.test.ts:1013`). With `concurrency` above 1 the scheduler starts no queued job once `destroy()` has begun; the jobs that run are waited for and closed, and the call without options still resolves (`packages/core/src/generator/LifecycleEmitter.ts:504`). The promise of `initialize()` is not rejected early by a destroy: it ends with the work, as before (`packages/core/tests/generator/t07-initialisation-runtime.test.ts:740`).

### The errors

| What happened | `initialize()` rejects with | The container |
|---------------|-----------------------------|---------------|
| The signal aborts, and the work then ends by the abort | `signal.reason`, the same object, at the moment of the abort | Failed, with `signal.reason` as its failure |
| The signal aborts, then a factory throws `E` | `signal.reason` (the caller was already told) | Failed. The failure is `E`, or a wrapper (same message, `cause` `E`, `cleanupErrors`) when a `dispose` threw during the rollback |
| A factory throws `E` before any abort | `E`, or the wrapper | Failed |
| `concurrency` above 1 and two factories throw | an `AggregateError`, see above | Failed |

The work keeps the first failure it meets: a factory error that is thrown before the next check wins over the abort reason, and the abort reason is what the check throws when nothing failed first. Cleanup errors keep the wrapper described under [When initialization fails](#when-initialization-fails) (`packages/core/src/generator/LifecycleEmitter.ts:670` to `:675`). No rejection is left unobserved: the work promise is always read, also after the caller stopped waiting (`packages/core/src/generator/LifecycleEmitter.ts:634` to `:637`).

### A deadline is yours

The container has no timeout and never will pick one. A deadline is a signal you build: `AbortSignal.timeout(ms)` where your runtime has it, or an `AbortController` with a timer that you clear in `finally`:

```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('startup took too long')), 10_000);
try {
  await container.initialize({ signal: controller.signal });
} finally {
  clearTimeout(timer);
}
```

A deadline does not interrupt JavaScript. After it, the promise you waited on is rejected, but a factory that ignores the signal is still running, and its value is still closed when it returns. The container is never reported destroyed, and a dependency a running factory uses is never closed, because of a timeout. Forcing the process to stop is a decision of the process or the server; the container never calls `process.exit`.

### Sync containers

A container with no async work has nothing to cancel while it runs. `initialize({ signal })` with a signal that is already aborted rejects with `signal.reason` before the eager roots run, and leaves the container as it was (`packages/core/src/generator/LifecycleEmitter.ts:752`, `packages/core/src/generator/LifecycleEmitter.ts:764`). A signal that is not aborted changes nothing, and its factories get a signal that never aborts.

## When initialization fails

`initialize()` first rolls back. The owned instances built during the failed attempt are disposed in reverse order of construction, with the same rules as `destroy()`: `dispose()`, else `[Symbol.asyncDispose]()`, else `[Symbol.dispose]()`, and a promise the method returns is awaited (see [Disposable Services](./disposable.md#standard-protocols)). Borrowed instances are left alone (`packages/core/src/generator/LifecycleEmitter.ts:650` to `:653`). Then it rejects, in one of two ways:

- With the factory's own error, when every `dispose` succeeded.
- With a new `Error` when a `dispose` threw. It has the same message, a `cause` (the factory's error) and `cleanupErrors` (the errors thrown by `dispose`). The rollback does not stop at the first failing `dispose` (`packages/core/src/generator/LifecycleEmitter.ts:655` to `:664`).

The container is then failed:

- another `initialize()` rejects with that same error (or wrapper),
- `resolve()` throws `NEO_CONTAINER_FAILED`,
- `createScope()` throws `NEO_CONTAINER_FAILED` (`packages/core/src/generator/LifecycleEmitter.ts:776` to `:778` for a container with async work, `:784` to `:786` without),
- nothing is retried by itself.

A failed container cannot be repaired. To try again, build a new container. Or keep a root container that never ran `initialize()`, take your scopes from it, and drop a scope that failed: the root stays usable. See [States, Scopes and Ownership](./states-and-ownership.md).

`tests/e2e/t20-docs-examples.test.ts` runs all of this: the rollback order, the wrapper with `cause` and `cleanupErrors`, `NEO_CONTAINER_FAILED` on `resolve()` and `createScope()`, and a second scope that succeeds after the first failed.

## Constraints

::: warning Singleton only
An async factory cannot be `lifecycle: 'transient'`. The build fails with `NEO_ASYNC_TRANSIENT`: a transient is created on each `resolve()`, which would have to be async.
:::

- `AsyncContainer` is a deprecated alias of `CoreContainer` and adds no method (`packages/neosyringe/src/types.ts:673`). Use `CoreContainer`, or let the type come from `defineBuilderConfig`.

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
