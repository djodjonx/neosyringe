# Disposable Services

Release resources (database connections, file handles, subscriptions) automatically when the container is destroyed.

## The Problem

Services that hold external resources need explicit cleanup. Without a lifecycle hook, resources leak when you replace or shut down a container.

## The Solution

Implement `IDisposable` or `IAsyncDisposable`. NeoSyringe calls `dispose()` automatically when `container.destroy()` is invoked. A class that implements the standard `[Symbol.dispose]()` or `[Symbol.asyncDispose]()` (TypeScript 5.2, `lib: ["ESNext.Disposable"]`) is released the same way. See [Standard protocols](#standard-protocols).

```typescript
import { IDisposable, IAsyncDisposable } from '@djodjonx/neosyringe';

// Sync cleanup
class DbConnection implements IDisposable {
  private pool = new Pool();

  query(sql: string) { return this.pool.query(sql); }

  dispose(): void {
    this.pool.end();
  }
}

// Async cleanup
class RedisClient implements IAsyncDisposable {
  private client = createClient();

  async get(key: string) { return this.client.get(key); }

  async dispose(): Promise<void> {
    await this.client.quit();
  }
}

export const container = defineBuilderConfig({
  injections: [
    { token: DbConnection },
    { token: RedisClient },
  ]
});
```

```typescript
// Shutdown
await container.destroy();
// DbConnection.dispose() and RedisClient.dispose() are called automatically
```

## How It Works

NeoSyringe detects the disposer at compile time by inspecting the class's declared type: a `dispose` method, or a method keyed by `Symbol.dispose` or `Symbol.asyncDispose`. The generated `destroy()` method:

1. Calls the disposer of each cached singleton **in reverse dependency order** (dependents before dependencies)
2. Checks `instances.has()` first — services never resolved are skipped
3. Clears the instance cache last

When a container has a disposal slot, the generated `destroy()` is `async` (`packages/core/src/generator/LifecycleEmitter.ts:908`): the disposers are called at once, in the same order, and `destroy()` resolves when every promise they returned has settled.

## Standard protocols

One method releases one instance, and it is called once, on the instance itself. The order is the one the generated code tries at run time (`packages/core/src/generator/LifecycleEmitter.ts:35-51`):

| Order | Method | Used when |
|-------|--------|-----------|
| 1 | `dispose()` | it is a function, own or inherited |
| 2 | `[Symbol.asyncDispose]()` | no callable `dispose`, and the method is not `null` or `undefined` |
| 3 | `[Symbol.dispose]()` | none of the above |

- A class with three methods runs `dispose()` only. If you want the others, call them from `dispose()`.
- A `dispose` that is not a function gives way to the symbols. A symbol member that is neither a function, `null` nor `undefined` is refused: `destroy()` reports a `TypeError` with the message `disposal protocol must be callable` and still releases the other services (`packages/core/src/generator/LifecycleEmitter.ts:46`).
- Everything a disposer returns is awaited when it is a promise, whatever its declared type: a `dispose(): void` that returns a pending promise at run time is awaited too (`packages/core/src/generator/LifecycleEmitter.ts:912-920`). Every failure is collected, the cleanup goes on, and `destroy()` rejects with one `AggregateError` that lists them all (`packages/core/src/generator/LifecycleEmitter.ts:953`).
- The build finds a symbol-keyed method through the TypeScript checker, by the identity of the symbol, never by the text of a name. A method called `'Symbol.dispose'`, or keyed by another `unique symbol`, is not a disposer. With no disposable lib in the program the symbols do not exist for the checker and the build finds only `dispose()` (`packages/core/src/analyzer/parsers/InjectionParser.ts:617`).
- A singleton returned by a factory is looked at when it is disposed: a value that is not an object or a function is skipped (`packages/core/src/generator/LifecycleEmitter.ts:37`), and the three methods are tried in the order above. Transients, values, borrowed results, parent services, scope inputs, aliases' targets owned elsewhere and `override()` mocks are never disposed by this container, as before.

The symbols are read from `Symbol` when a value is disposed, never when the module loads, and nothing is installed on `Symbol`. A runtime that has no `Symbol.dispose` simply never finds one (`packages/core/src/generator/LifecycleEmitter.ts:41-42`).

## `await using`

A container and a scope are `await using` resources when the consumer's TypeScript lib declares `Symbol.asyncDispose`: `[Symbol.asyncDispose]()` calls `destroy()` (`packages/core/src/generator/LifecycleEmitter.ts:79`, `packages/neosyringe/src/types.ts:21`).

```typescript
// tsconfig: "lib": ["ES2022", "ESNext.Disposable"]
async function handle(request: Request) {
  await using scope = container.createScope();
  return scope.resolve(Handler).run(request);
} // scope.destroy() ran here; the parent container is open
```

- The scope is closed when the block ends. The parent stays open. A scope made from a `scopeInputs` template is released the same way, and so is the template itself.
- The language decides what happens to the errors. When the body throws and the disposal fails too, you get a `SuppressedError`: `error` is the disposal failure (an `AggregateError` from `destroy()`) and `suppressed` is the error of the body (`packages/core/tests/generator/t21-disposal-runtime.test.ts`, `T21-P12`).
- There is no synchronous `using`: the cleanup may be asynchronous, so a container has no `[Symbol.dispose]()` and `using scope = container.createScope()` is a compile error (`tests/consumer-types/negative-disposable/consumer.ts`).
- The type is added only when the lib has the symbol. A consumer without `ESNext.Disposable` sees no new member and no missing global type, and the minimum TypeScript version does not change. `destroy()` ends a container everywhere (`packages/neosyringe/src/types.ts:21-23`).
- Where the runtime has no `Symbol.asyncDispose` the protocol does not exist; the generated class stores the delegate under the key `undefined` and nothing else changes. `await container.destroy()` works on every runtime. No `Symbol.for` stand-in is installed, and NeoSyringe adds no polyfill.

## Migration

- **A resource that only has `[Symbol.dispose]` or `[Symbol.asyncDispose]` used to be ignored. It is now closed by `destroy()`**, `override()` and the rollback of a failed `initialize()`. If your code already closed it by hand, it is now closed twice: remove one of the two calls, or make the method idempotent.
- **A `dispose(): void` that returns a promise is now awaited.** Before, `destroy()` did not wait for it. Now `destroy()` resolves after the promise settles, and rejects if it rejects. A container with a disposal slot has an `async` `destroy()`: the disposers are still called during the call, and the promise it returns settles once the promises they returned have settled, not at once (`packages/core/src/generator/LifecycleEmitter.ts:908`, `packages/core/src/generator/LifecycleEmitter.ts:1141`).
- A class that has both `dispose()` and a symbol method keeps running `dispose()` only.
- **A hand-built object typed `CoreContainer`, `Container`, `AsyncContainer`, `ContainerTemplate` or `BoundContainer` (a test double, an adapter) needs `[Symbol.asyncDispose]()` when the lib declares the symbol** (`ESNext` or `ESNext.Disposable`). The member is required there, and without it the object stops compiling with `TS2741` (`tests/consumer-types/negative-disposable/consumer.ts:34` to `:37`). Add `async [Symbol.asyncDispose]() { await this.destroy(); }` and it compiles again (`tests/consumer-types/positive-disposable/consumer.ts:61` to `:84`). With a lib that has no such symbol nothing changes.
- **`override()` and `clearOverrides()` can now answer `NEO_CONTAINER_BUSY` instead of `NEO_CONTAINER_DESTROYED`.** A synchronous graph whose only disposal slots are `dispose()` classes used to finish `destroy()` before it returned. Its `destroy()` is now `async`, so the container stays busy until the promise settles, and a call made in that window is refused with `NEO_CONTAINER_BUSY`. After the promise settles, the code is `NEO_CONTAINER_DESTROYED` as before (`packages/core/src/generator/LifecycleEmitter.ts:1022` and `:1130`, `packages/core/tests/generator/t21-disposal-runtime.test.ts`, `T21-W18`).
- A transient with only a symbol disposer, captured by a singleton, is now refused with `NEO_DISPOSABLE_TRANSIENT_CAPTURED`, like a transient with `dispose()`.

## Constraints

::: warning Singletons Only
Only singleton services (the default lifecycle) are disposed. Transient services are not cached, so `destroy()` cannot track them. Manage transient resource cleanup in your own code.
:::

::: tip Factories, values, mocks, parents
A singleton factory is disposed when its result has a callable `dispose`. Opt out with `ownership: 'borrowed'` when someone else owns that object. `useValue` is never disposed. An `override()` mock is never disposed. A child never disposes a parent reference.
:::

## Dispose Order

Services are disposed in reverse dependency order: if `UserService` depends on `DbConnection`, then `UserService.dispose()` is called before `DbConnection.dispose()`.

## Testing

`destroy()` is terminal. After it, `resolve()` and `initialize()` throw `NEO_CONTAINER_DESTROYED`. A second `destroy()` does nothing.

Use `createScope()` when each test needs its own cache. Destroy the scope. Leave the shared parent open.

```typescript
const scope = container.createScope();
await scope.initialize();
// ...
await scope.destroy();
```
