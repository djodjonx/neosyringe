# States, Scopes and Ownership

What a generated container does at each step of its life, who closes what, and what a factory may do.

Everything below was run against the built packages. The tests are in `tests/e2e/t20-docs-examples.test.ts` ("T20 states and ownership").

## Operations every container has

`CoreContainer` is the type of every generated container (`packages/neosyringe/src/types.ts:119`).

| Operation | Meaning |
|-----------|---------|
| `resolve(token)` | One instance, synchronously. |
| `resolveAll(token)` | A new array with every `multi: true` contribution. |
| `initialize(options?)` | Brings async singletons to ready. A container with no async work resolves it at once. `initialize({ signal })` can be cancelled: see [Async Factories](./async-factories.md#cancelling-an-initialization). |
| `destroy()` | Ends the container. Terminal and idempotent. |
| `createScope()` | A new container with the same recipes and the same parents, and empty caches. |

The full profile also has `override`, `overrideMany`, `clearOverrides` and `on` (`Container`, `packages/neosyringe/src/types.ts:196`). See [profiles](./profiles.md).

## States

| State | `resolve` | `initialize` | `destroy` |
|-------|-----------|--------------|-----------|
| Created, async work pending | Throws `NEO_NOT_INITIALIZED` | Starts the work | Ends the container |
| Initializing | Throws `NEO_NOT_INITIALIZED` | Returns the same promise. A different signal is refused with `NEO_INIT_OPTIONS_CONFLICT` | Waits for the work, then ends the container |
| Cancelling (the signal of `initialize({ signal })` aborted, the work has not ended) | Throws `NEO_NOT_INITIALIZED` | Same as Initializing | Waits for the work, then ends the container |
| Ready | Works | Returns at once | Disposes owned instances |
| Reconfiguring (during `override` / `overrideMany` / `clearOverrides`) | Throws `NEO_CONTAINER_BUSY` | Rejects with `NEO_CONTAINER_BUSY` | Rejects with `NEO_CONTAINER_BUSY` |
| Failed (`initialize()` rejected) | Throws `NEO_CONTAINER_FAILED` | Rejects again with the first error | Ends the container |
| Destroyed | Throws `NEO_CONTAINER_DESTROYED` | Throws `NEO_CONTAINER_DESTROYED` | Does nothing |

The codes come from `packages/core/src/generator/LifecycleEmitter.ts:585` to `:594`. Each cell was checked by running a container, except the `destroy` cell of the Initializing row, which is source only (`packages/core/src/generator/LifecycleEmitter.ts:1309` to `:1313`):

- A container with an async factory refuses `resolve` before `initialize` (`async.ts` below).
- When `initialize()` rejects, it first rolls back: the owned instances built during the attempt are disposed in reverse order. It rejects with the factory's own error, or, if a `dispose` threw during the rollback, with a new `Error` that has the same message, a `cause` (the factory's error) and `cleanupErrors`. The next `initialize()` rejects with the same object. `resolve` throws `NEO_CONTAINER_FAILED`. `createScope()` throws `NEO_CONTAINER_FAILED` too, so a failed container cannot give you a fresh scope. Nothing restarts by itself. To try again, build a new container, or take scopes from a root that never ran `initialize()` and drop the scope that failed.
- While `override`, `overrideMany` or `clearOverrides` is still closing the old instances, `resolve`, `initialize`, `destroy`, `createScope`, `override`, `overrideMany` and `clearOverrides` all reject or throw `NEO_CONTAINER_BUSY`. This holds for a container with async factories and for one without. Await each call.
- While `initialize()` is running, or cancelling, `override`, `overrideMany`, `clearOverrides` and `createScope()` throw `NEO_CONTAINER_BUSY`, and `resolve` throws `NEO_NOT_INITIALIZED` (`packages/core/src/generator/LifecycleEmitter.ts:682`, `packages/core/src/generator/LifecycleEmitter.ts:780`). Cancelling is a state of its own only for the work that is still running: once it ends, the container is Failed, with `signal.reason` as its failure unless a factory failed first.
- `override`, `overrideMany` and `clearOverrides` are refused with `NEO_CONTAINER_BUSY` while the container is destroying too. This is source only (`packages/core/src/generator/LifecycleEmitter.ts:1142` to `:1143`), not run here.
- While `destroy()` still waits for a slow disposer, the container answers as destroyed: `resolve` and `resolveMany` throw `NEO_CONTAINER_DESTROYED` (`packages/core/src/generator/LifecycleEmitter.ts:691`) and so does `createScope()` (`packages/core/src/generator/LifecycleEmitter.ts:774`). Run on the generated code of both emitters by the `I2` tests of `packages/core/tests/generator/f-composition-runtime.test.ts`.

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

`createScope()` is the same container for the usage check (`packages/core/src/analyzer/collectors/resolutionUsages.ts:149`). `scope.resolve(Repo)` is checked like a resolve on that container. A receiver the build cannot decide, such as `get().createScope()`, stays `NEO_UNKNOWN_CONTAINER` (`packages/core/src/analyzer/validators/MissingDependencyValidator.ts:136`). In the usage check, `validation: 'compatible'` turns only that undecidable case into a warning (`packages/core/src/analyzer/validators/MissingDependencyValidator.ts:135`). It does not make legacy factories legal; see the [migration guide](./migration.md).

### Scope inputs

A scope often needs data that belongs to one request, one tenant or one transaction. A builder that declares `scopeInputs` receives it in `createScope({ values })`, and the services of that scope read it like any other dependency. Nothing is shared between scopes: no request context exists, and a scope never copies the values of the scope it comes from (`packages/core/src/generator/inputEmitter.ts:123` to `:135`).

```typescript
const requestToken = useInterface<RequestContext>();
const retries = useProperty<number>(Handler, 'retries');

export const requests = defineBuilderConfig({
  useContainer: application,    // optional: a normal parent, as before
  scopeInputs: [requestToken, retries],
  injections: [{ token: Handler }],
});

const scope = requests.createScope({
  values: [
    { token: retries, useValue: 3 },
    { token: requestToken, useValue: { requestId, tenantId } },
  ],
});
await scope.initialize();
const handler = scope.resolve(Handler);   // built with this request, on first use
await scope.destroy();                    // closes the Handler it built, never the request object
```

A scope of a graph with async factories must be initialized: call `await scope.initialize()` before its first `resolve`, or `resolve` throws `NEO_NOT_INITIALIZED`. The example below has no async factory, so it does not call `initialize()`. It is compiled with no cast and run by `tests/e2e/g07-docs-examples.test.ts`:

<<< @/../examples/new-api/scope-inputs.ts#container

<<< @/../examples/new-api/scope-inputs.ts#scopes

- **The builder is a model.** Its type has `createScope` and `destroy` only (`ContainerTemplate`, see [types](/api/types#containertemplate-and-boundcontainer)). Called from untyped code, its `resolve`, `resolveAll`, `resolveMany` and `initialize` throw `NEO_SCOPE_INPUTS_UNBOUND`, which names the missing inputs, before any factory runs. The model stays usable.
- **Everything is checked first.** Each input is required, in any order, once. An unknown token, a repeated token, a missing input and options of the wrong shape are refused with a stable code before any value is stored and before any factory runs (`NEO_SCOPE_INPUT_UNKNOWN`, `NEO_SCOPE_INPUT_DUPLICATE`, `NEO_SCOPE_INPUT_MISSING`, `NEO_SCOPE_INPUTS_INVALID`; see [errors](/api/errors#thrown-at-run-time-by-the-generated-container)). The list is read once: the entries are copied, so changing the array afterwards changes nothing.
- **A value is present when you give it.** `{ token, useValue: undefined }` is the value `undefined`. An entry you leave out is missing.
- **Two scopes, two states.** Each scope has its own values, its own singletons and its own destruction. Destroying one changes neither the model, nor its parents, nor a sibling.
- **Values are borrowed.** `scope.destroy()` disposes the singletons the scope built and owns, once. It never disposes a value you gave, even a disposable one and even one a parent owns: the owner closes it (`packages/core/src/generator/ResolveEmitter.ts:54` to `:54`).
- **First construction sees them.** A lazy singleton, an `eager` root of a closed container and an async singleton read the values when they are first built. A closed container does not export an input: `scope.resolve(requestToken)` is `NEO_ROOT_NOT_EXPORTED` there, at build time when the call is visible.
- **A destroyed parent is refused.** `createScope({ values })` of a container whose parent was destroyed throws `NEO_SCOPE_PARENT_DESTROYED`, and a destroyed container throws `NEO_CONTAINER_DESTROYED`. A destroyed scope releases its values: the map it was built with, and the borrowed mark it set on each value it resolved (`packages/core/src/generator/inputEmitter.ts:144` to `:155`), so the scope does not keep the objects you gave it alive. A `destroy()` refused with `NEO_CONTAINER_BUSY` (during an `override`) closes nothing and releases nothing: the scope still answers its values.
- **Not in a partial, not on a class.** An input is an interface or a property token (`useInterface<T>()`, `useProperty(...)`), never a class, never `multi`. A partial cannot declare `scopeInputs` in this version: declare them on the builder and list the tokens in the partial's `expects`.

## Who owns what
| Origin | Owner | Closed by `destroy()` |
|--------|-------|-----------------------|
| Class singleton built by this container | This container | Yes, if it has a `dispose` function, or a `[Symbol.asyncDispose]` or `[Symbol.dispose]` method ([Disposable Services](./disposable.md#standard-protocols)) |
| Singleton returned by a factory in this container | This container | Yes, if it has a `dispose` function, or one of the two symbol methods |
| Factory with `ownership: 'borrowed'` | Whoever created the resource | No |
| `useValue` | Whoever created the value | No |
| Value given to `createScope({ values })` | Whoever created the value | No |
| Service resolved from a parent | The parent | Never by the child |
| Transient instance | The caller | No: the container does not keep it |
| Mock installed with `override` | The test | No |

- Only instances that were really built are closed. A singleton nobody resolved has nothing to close.
- `useValue` cannot be declared `ownership: 'owned'`. The build fails with `NEO_CONFIG_UNSUPPORTED` and says to register a factory instead (`packages/core/src/analyzer/parsers/ConfigParser.ts`, tested by running the fixture).
- The containers do not guess ownership of a resource hidden inside a library. Pass it with `useValue` or `ownership: 'borrowed'`.
- **Transients.** The container never closes a transient. A strict build refuses a disposable transient captured by a singleton with `NEO_DISPOSABLE_TRANSIENT_CAPTURED` (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:76`). A singleton marked `scoped: true` is still refused. A transient consumer is not, including one marked `scoped: true`. A transient whose type has no `dispose` call stays allowed (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:81`). `ownership: 'borrowed'` on a transient does not lift the refusal (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:81`). The container does not dispose the transient for you. Register it as a singleton, or construct it inside the singleton and close it from that service's own `dispose`. `validation: 'compatible'` reports a warning only when you construct the core analyzer yourself (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:304`). The plugin calls `new Analyzer(program).extractAll()` with no options (`packages/unplugin/src/session.ts:561`), and its `validation` option reaches only the usage check (`packages/unplugin/src/index.ts:32`, `packages/unplugin/src/buildEndUsages.ts:29`). The CLI constructs `new Analyzer(program)` with no options and fails on `extractAllErrors` (`packages/cli/src/index.ts:105`, `packages/cli/src/index.ts:116`).
- Destroying a child does not destroy the parent. After the parent is destroyed, a child that needs it throws `NEO_SCOPE_PARENT_DESTROYED`, even for a service the child had already cached.
- A parent-owned service keeps the parent's dependencies. Replacing `Logger` in a child does not rewire a `Service` that the parent owns. Register `Service` in the child too. See [scoped injections](./scoped-injections.md).

## Factories

<<< @/../examples/new-api/factories.ts#with-dependencies

- **`dependencies` is required** in strict validation, even as `[]`. A factory without it fails the build with `NEO_FACTORY_DEPENDENCIES_REQUIRED` (`packages/core/src/analyzer/parsers/InjectionParser.ts:761`). The TypeScript type of an injection still lets you omit it (`packages/neosyringe/src/types.ts:540`): the type does not warn you, the build does.
- An entry is a token, or `{ all: token }` for `resolveAll`.
- The factory receives a `FactoryContext` with `resolve`, `resolveAll`, `resolveMany` and `signal` (`packages/neosyringe/src/types.ts:297`, `packages/neosyringe/src/types.ts:305`). It has no `initialize`, `destroy`, `override`, `on` or `createScope`. `signal` aborts when the initialization the factory runs for is cancelled or the container is destroyed; a factory called outside an initialization gets one that never aborts (see [Async Factories](./async-factories.md#what-a-factory-sees)).
- A token that is not in `dependencies` throws `NEO_UNDECLARED_FACTORY_DEP` when the factory asks for it, including from a helper function it calls.
- The context is only valid while the factory runs. Keeping it and calling it later, or reading its `signal`, throws `NEO_FACTORY_CONTEXT_EXPIRED`.
- A factory may return a value or a promise. A promise makes the token async: `initialize()` waits for it.
- An async factory cannot be `lifecycle: 'transient'`: the build fails with `NEO_ASYNC_TRANSIENT`.
- A factory that calls `resolve` or `resolveAll` directly on a captured container, such as `otherContainer.resolve(Dep)`, fails the build with `NEO_UNDECLARED_FACTORY_DEP` ("resolves a captured container instead of its context", `packages/core/src/analyzer/parsers/InjectionParser.ts:767` to `:692`). Only indirect access is out of reach of the build: a helper function that holds the container, or a receiver that is not a plain variable. Nothing checks it. Pass the value in as a token instead.

## Other limits

- Resolving a `multi` token with `resolve` fails with `NEO_MULTI_REQUIRES_RESOLVE_ALL`, at build time when the call is visible.
- `override` of a `multi` token rejects with `NEO_OVERRIDE_MULTI_UNSUPPORTED`. So does a `multi` token in an `overrideMany` batch.
- `on('resolve', listener)` fires on every successful single `resolve`, cache hits included, and returns the function that unsubscribes.

## Limits

- A ring of factory nodes is rejected with `NEO_CYCLE` and no `RangeError` at depth 100, 500 and 1000. The product test covers 100, 500 and 1000; its passing check is the ring of 1000 (`packages/core/tests/generator/t06-lifecycle-corpus.test.ts`, "L10 long ring rejected by the product"): `Analyzer.extractAll`, then `GraphValidator.validateAll`. A ring of 2000 needs about 650-700 KB of stack: it passes at the default stack (about 984 KB) and at `--stack-size=700`, and throws `RangeError: Maximum call stack size exceeded` in `GraphValidator.detectCycleCollect` (`packages/core/src/generator/GraphValidator.ts:153`) at `--stack-size=650`. Depth 5000 is the first of 100, 500, 1000, 2000 and 5000 that overflows on the default stack: the same `RangeError` at `GraphValidator.detectCycleCollect` (`packages/core/src/generator/GraphValidator.ts:153`). The walk is still recursive (`packages/core/src/generator/GraphValidator.ts:171`). Open point for topic 13.
- A local transient factory that returns `undefined` is not the same on the two emitters. The reference emitter does not store the result, so `resolve` falls through (`packages/core/src/generator/Generator.ts:403`) and throws `NeoServiceNotFoundError` with message `[T06UndefT] Service not found or token not registered: UndefT` (`packages/core/src/generator/Generator.ts:425`). The optimized emitter returns `undefined` (`packages/core/src/generator/ResolveEmitter.ts:290`). Open point. The corpus does not generate that case, and no test asserts the throw.

## Migration

A singleton whose value is `undefined` is now returned on the reference emitter (`packages/core/src/generator/Generator.ts:403`) instead of `NeoServiceNotFoundError`. The same check keeps that local `undefined` from falling through to a parent.

A sync factory that calls `initialize()` while the state is `initializing` and that factory is still on the synchronous stack (`this._syncInit > 0`) gets `NEO_CONTAINER_BUSY` (`packages/core/src/generator/LifecycleEmitter.ts:585`) instead of joining the in-flight promise, which could deadlock. In every other state the call keeps its own result: `ready` resolves (`packages/core/src/generator/LifecycleEmitter.ts:591`), `failed` rejects with the first failure (`packages/core/src/generator/LifecycleEmitter.ts:592`), and `destroyed` throws `NEO_CONTAINER_DESTROYED` (`packages/core/src/generator/LifecycleEmitter.ts:593` to `:595`). The depth flag lives on both container shapes (`packages/core/src/generator/Generator.ts:928`). It is raised only around the synchronous factory call, and only when the container has async work (`packages/core/src/generator/FactoryEmitter.ts:353` to `:357`). A container with no async factory does not emit the increment or the decrement: its `initialize()` never reads `_syncInit` (`packages/core/src/generator/FactoryEmitter.ts:341`). A factory that awaits, then calls `initialize()`, is not flagged. A factory resolved after the container is ready, including one resolved from a scope, gets the resolved promise.
