# States, Scopes and Ownership

What a generated container does at each step of its life, who closes what, and what a factory may do.

Everything below was run against the built packages. The tests are in `tests/e2e/t20-docs-examples.test.ts` ("T20 states and ownership").

## Operations every container has

`CoreContainer` is the type of every generated container (`packages/neosyringe/src/types.ts:18`).

| Operation | Meaning |
|-----------|---------|
| `resolve(token)` | One instance, synchronously. |
| `resolveAll(token)` | A new array with every `multi: true` contribution. |
| `initialize()` | Brings async singletons to ready. A container with no async work resolves it at once. |
| `destroy()` | Ends the container. Terminal and idempotent. |
| `createScope()` | A new container with the same recipes and the same parents, and empty caches. |

The full profile also has `override`, `clearOverrides` and `on` (`Container`, `packages/neosyringe/src/types.ts:53`). See [profiles](./profiles.md).

## States

| State | `resolve` | `initialize` | `destroy` |
|-------|-----------|--------------|-----------|
| Created, async work pending | Throws `NEO_NOT_INITIALIZED` | Starts the work | Ends the container |
| Initializing | Throws `NEO_NOT_INITIALIZED` | Returns the same work | Waits for it, then ends the container |
| Ready | Works | Returns at once | Disposes owned instances |
| Reconfiguring (during `override` / `clearOverrides`) | Throws `NEO_CONTAINER_BUSY` | Rejects with `NEO_CONTAINER_BUSY` | Rejects with `NEO_CONTAINER_BUSY` |
| Failed (`initialize()` rejected) | Throws `NEO_CONTAINER_FAILED` | Rejects again with the first error | Ends the container |
| Destroyed | Throws `NEO_CONTAINER_DESTROYED` | Throws `NEO_CONTAINER_DESTROYED` | Does nothing |

The codes come from `packages/core/src/generator/LifecycleEmitter.ts:240` to `:249`. Each cell was checked by running a container, except the `destroy` cell of the Initializing row, which is source only (`packages/core/src/generator/LifecycleEmitter.ts:649` to `:651`):

- A container with an async factory refuses `resolve` before `initialize` (`async.ts` below).
- When `initialize()` rejects, it first rolls back: the owned instances built during the attempt are disposed in reverse order. It rejects with the factory's own error, or, if a `dispose` threw during the rollback, with a new `Error` that has the same message, a `cause` (the factory's error) and `cleanupErrors`. The next `initialize()` rejects with the same object. `resolve` throws `NEO_CONTAINER_FAILED`. `createScope()` throws `NEO_CONTAINER_FAILED` too, so a failed container cannot give you a fresh scope. Nothing restarts by itself. To try again, build a new container, or take scopes from a root that never ran `initialize()` and drop the scope that failed.
- While `override` or `clearOverrides` is still closing the old instances, `resolve`, `initialize`, `destroy`, `createScope`, `override` and `clearOverrides` all reject or throw `NEO_CONTAINER_BUSY`. This holds for a container with async factories and for one without. Await each call.
- While `initialize()` is running, `override`, `clearOverrides` and `createScope()` throw `NEO_CONTAINER_BUSY`, and `resolve` throws `NEO_NOT_INITIALIZED`.
- `override` and `clearOverrides` are refused with `NEO_CONTAINER_BUSY` while the container is destroying too. This is source only (`packages/core/src/generator/LifecycleEmitter.ts:516` to `:517`), not run here.

A container with no async factory and no eager root is ready at once. `scopes.ts` below resolves without calling `initialize()`.

### Always initialize before you resolve

<<< @/../examples/new-api/async.ts#container

```typescript
await container.initialize();            // once, at startup
const client = container.resolve(clientToken);   // synchronous from here on
await container.destroy();               // at shutdown
```

See [async factories](./async-factories.md).

## Scopes

`createScope()` returns a new container built from the same recipes. It copies no instance and does not call `initialize()`.

<<< @/../examples/new-api/scopes.ts#container

```typescript
const scope = container.createScope();
await scope.initialize();      // only needed when the graph has async work
const repo = scope.resolve(Repo);
await scope.destroy();         // closes this scope only
```

- Two scopes of a root container have their own singletons. Two scopes of a child container share the parent's services and own their local ones.
- Closing a scope closes neither the scope it came from nor the parent.
- A `useValue` expression is evaluated once. Every scope gets the same value by reference. Put a value that must differ per scope in a factory.
- Overrides and `on` listeners are not copied to a scope.
- You cannot create a scope from a destroyed container: `createScope()` throws `NEO_CONTAINER_DESTROYED`.
- There is no request context. A scope per request is something you create and close yourself.

`createScope()` is the same container for the usage check (`packages/core/src/analyzer/collectors/resolutionUsages.ts:147`). `scope.resolve(Repo)` is checked like a resolve on that container. A receiver the build cannot decide, such as `get().createScope()`, stays `NEO_UNKNOWN_CONTAINER` (`packages/core/src/analyzer/validators/MissingDependencyValidator.ts:136`). In the usage check, `validation: 'compatible'` turns only that undecidable case into a warning (`packages/core/src/analyzer/validators/MissingDependencyValidator.ts:135`). It does not make legacy factories legal; see the [migration guide](./migration.md).

## Who owns what

| Origin | Owner | Closed by `destroy()` |
|--------|-------|-----------------------|
| Class singleton built by this container | This container | Yes, if it has a `dispose` function |
| Singleton returned by a factory in this container | This container | Yes, if it has a `dispose` function |
| Factory with `ownership: 'borrowed'` | Whoever created the resource | No |
| `useValue` | Whoever created the value | No |
| Service resolved from a parent | The parent | Never by the child |
| Transient instance | The caller | No: the container does not keep it |
| Mock installed with `override` | The test | No |

- Only instances that were really built are closed. A singleton nobody resolved has nothing to close.
- `useValue` cannot be declared `ownership: 'owned'`. The build fails with `NEO_CONFIG_UNSUPPORTED` and says to register a factory instead (`packages/core/src/analyzer/parsers/ConfigParser.ts`, tested by running the fixture).
- The containers do not guess ownership of a resource hidden inside a library. Pass it with `useValue` or `ownership: 'borrowed'`.
- **Transients.** The container never closes a transient. A strict build refuses a disposable transient captured by a singleton with `NEO_DISPOSABLE_TRANSIENT_CAPTURED` (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:74`). A singleton marked `scoped: true` is still refused. A transient consumer is not, including one marked `scoped: true`. A transient whose type has no `dispose` call stays allowed (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:79`). `ownership: 'borrowed'` on a transient does not lift the refusal (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:79`). The container does not dispose the transient for you. Register it as a singleton, or construct it inside the singleton and close it from that service's own `dispose`. `validation: 'compatible'` reports a warning only when you construct the core analyzer yourself (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:301`). The plugin calls `new Analyzer(program).extractAll()` with no options (`packages/unplugin/src/session.ts:559`), and its `validation` option reaches only the usage check (`packages/unplugin/src/index.ts:32`, `packages/unplugin/src/buildEndUsages.ts:29`). The CLI constructs `new Analyzer(program)` with no options and fails on `extractAllErrors` (`packages/cli/src/index.ts:105`, `packages/cli/src/index.ts:116`).
- Destroying a child does not destroy the parent. After the parent is destroyed, a child that needs it throws `NEO_SCOPE_PARENT_DESTROYED`, even for a service the child had already cached.
- A parent-owned service keeps the parent's dependencies. Replacing `Logger` in a child does not rewire a `Service` that the parent owns. Register `Service` in the child too. See [scoped injections](./scoped-injections.md).

## Factories

<<< @/../examples/new-api/factories.ts#with-dependencies

- **`dependencies` is required** in strict validation, even as `[]`. A factory without it fails the build with `NEO_FACTORY_DEPENDENCIES_REQUIRED` (`packages/core/src/analyzer/parsers/InjectionParser.ts:469`). The TypeScript type of an injection still lets you omit it (`packages/neosyringe/src/types.ts:223`): the type does not warn you, the build does.
- An entry is a token, or `{ all: token }` for `resolveAll`.
- The factory receives a `FactoryContext` with `resolve` and `resolveAll` only (`packages/neosyringe/src/types.ts:94`). It has no `initialize`, `destroy`, `override`, `on` or `createScope`.
- A token that is not in `dependencies` throws `NEO_UNDECLARED_FACTORY_DEP` when the factory asks for it, including from a helper function it calls.
- The context is only valid while the factory runs. Keeping it and calling it later throws `NEO_FACTORY_CONTEXT_EXPIRED`.
- A factory may return a value or a promise. A promise makes the token async: `initialize()` waits for it.
- An async factory cannot be `lifecycle: 'transient'`: the build fails with `NEO_ASYNC_TRANSIENT`.
- A factory that calls `resolve` or `resolveAll` directly on a captured container, such as `otherContainer.resolve(Dep)`, fails the build with `NEO_UNDECLARED_FACTORY_DEP` ("resolves a captured container instead of its context", `packages/core/src/analyzer/parsers/InjectionParser.ts:584` to `:614`). Only indirect access is out of reach of the build: a helper function that holds the container, or a receiver that is not a plain variable. Nothing checks it. Pass the value in as a token instead.

## Other limits

- Resolving a `multi` token with `resolve` fails with `NEO_MULTI_REQUIRES_RESOLVE_ALL`, at build time when the call is visible.
- `override` of a `multi` token rejects with `NEO_OVERRIDE_MULTI_UNSUPPORTED`.
- `on('resolve', listener)` fires on every successful single `resolve`, cache hits included, and returns the function that unsubscribes.
