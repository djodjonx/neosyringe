# Observability

A production container can tell you what it is doing: when each service was built and how long it took, which step of `initialize()` is running, which disposal failed, and the state of the container as a few numbers. It is a build option, off by default. A build without it has no observation code, no `observe()` member and reads no clock.

The reference for the fields is [Types](/api/types#observation-events-and-the-state-snapshot). This page says when to turn it on and what it does.

## Turn it on

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';

export default defineConfig({
  plugins: [neoSyringePlugin.vite({ observation: true })]
});
```

The option is `observation` (`packages/unplugin/src/index.ts:51`). It is its own switch: it does not turn on `debug` or `testOverrides`, and they do not turn it on. Unlike those two it is allowed when `NODE_ENV` is `production`, because production is what it is for. The ts-patch transformer reads the same key (`packages/unplugin/src/transformer.ts:69`), and both reach the one call that builds a generator for a file (`packages/unplugin/src/session.ts:785`).

The flag is fixed at build time. The generated code never reads `process`.

## Subscribe

A container built with the option has two members, `observe(sink, options?)` and `stateSnapshot()`. TypeScript cannot see the build option, so both are optional on the type of the container: write `container.observe?.(sink)`. In a build without the option they are `undefined`.

```typescript
import { container } from './container';

const stop = container.observe?.((event) => {
  if (event.kind === 'end' && event.outcome === 'error') {
    console.warn(event.phase, event.registrationId, event.errorCode ?? 'no NEO code');
  }
});

// later: no more events, and the container no longer holds the sink
stop?.();
```

Both profiles have the two members. The minimal profile gets these two and nothing else of the full profile: no `on('resolve')`, no `override`. The full profile keeps `on('resolve')` as it was ([Profiles](/guide/profiles#observation)).

A sink subscribed to a container sees the events of the whole tree: the container and every scope made from it. A sink subscribed through a scope sees that tree too: the events of the root and of its sibling scopes, not only its own. Several sinks may be subscribed at once; each reads the clock it was given.

The container or the scope that took a sink lets go of it as soon as its `destroy()` is over, after the dispose events it makes have reached the sink (`packages/core/src/generator/LifecycleEmitter.ts:1273`, `:1290`, `:1306` and `:1317`; `packages/core/src/generator/observationEmitter.ts:222`). Unsubscribing lets it go earlier. Destroying a scope releases the sinks taken through that scope only; destroying the root releases the sinks taken through the root only. A sink subscribed after the container or the scope is destroyed is never called, and `observe()` still answers a function to unsubscribe. A value that is not a function is refused with a `TypeError` (`packages/core/src/generator/observationEmitter.ts:209`).

## What an operation is

An operation has a `start` event and an `end` event. There are three phases.

| Phase | The operation | The end comes |
|-------|---------------|---------------|
| `construct` | A class provider or a factory builds a value. | When the constructor returns, or when the promise of an async factory settles. |
| `initialize` | One async step of `initialize()`: the construct of an async singleton and the store of its value. | When that step has settled. |
| `dispose` | The disposer of one value, from `destroy()`, from an override, or from the rollback of a failed initialization. | When the disposer returns, or when the promise it returns settles. |

Each construct is observed where its creator builds it (`packages/core/src/generator/FactoryEmitter.ts:516`). A service that is already built is a cache hit: nothing is built, so nothing is published. A `useValue` registration and a scope input are not built by the container and publish nothing (`packages/core/src/generator/FactoryEmitter.ts:619` to `:625`). A transient service publishes a pair each time it is resolved. A value that has no disposer is not a disposal (`packages/core/src/generator/LifecycleEmitter.ts:1017`).

Each `start` a sink received has exactly one `end`, with `outcome` `ok` or `error`. An operation that began before a sink was subscribed ends without telling that sink, and one that began before the sink left ends without telling it either (`packages/core/src/generator/observationEmitter.ts:73` to `:95`).

## What an event holds

Only scalars: `containerId`, `scopeId`, `registrationId`, `phase` and `kind`, and on an `end` also `outcome` and `durationMs`, and `errorCode` when the operation failed with a code that looks like `NEO_*`. An event never holds a service, a token object, an error message or a stack. The event is frozen, so a sink cannot change what the next sink receives.

- `registrationId` is the id of the registration in the build artifact: the token id the graph uses, which is the `runtimeKey` of an exported token in the tokens manifest. A contribution to a multi token is `multi:<token id>:<index>`. A table from the build is how you turn an id into a name; the container does not carry names.
- `containerId` is the opaque id of the container artifact. A scope has the id of its container.
- `scopeId` is `root` for the container itself and `s1`, `s2`... for its scopes. Do not use it as a metric label: a service that makes a scope per request makes an unbounded number of ids. Keep it for sampled traces and logs.
- `errorCode` is only a code of the error as the application threw it (`packages/core/src/generator/observationEmitter.ts:165`). A plain `Error` has none, and a `code` such as `ENOENT` or `neo_x` is dropped.
- `durationMs` is never negative. A clock that throws or answers a value that is not a number when the operation ends does not lose the `end`: it is published without `durationMs` (`packages/core/src/generator/observationEmitter.ts:91`). A clock that fails at the `start` gives that sink no event for the operation, neither a `start` nor an `end`.

## The clock

Durations come from a monotonic clock in milliseconds. Pass your own with `observe(sink, { now })`. By default it is `performance.now`, read only while a sink is subscribed, and `Date.now` where there is no `performance` (`packages/core/src/generator/observationEmitter.ts:142`). With no sink subscribed the container reads no clock at all and builds no event object (`packages/core/src/generator/observationEmitter.ts:69`): the counters below still move, and that is all.

## A sink cannot hurt the service

A sink runs inside the operation it observes, so keep it fast. A sink must not call back into the container: not `resolve`, `initialize`, `destroy` or `observe`. It runs before the value it is told about is cached, so a call from it is not a supported way to read that value. What it throws is ignored. A promise it returns, or a value whose `then` throws, never leaves an unhandled rejection (`packages/core/src/generator/observationEmitter.ts:155`). The result of the operation, and the error it threw, are the ones the application would have seen without the sink.

## The state snapshot

`stateSnapshot()` answers a new object of scalars each time, to find a container that is stuck.

```typescript
container.stateSnapshot?.();
// { state: 'initializing', constructs: 2, initializes: 1, disposes: 0, failures: 0,
//   cancellations: 0, inFlight: { construct: 1, initialize: 1, dispose: 0 }, activeScopes: 0 }
```

- `state` is the state of the container asked. An async container has its state machine (`created`, `initializing`, `cancelling`, `ready`, `failed`, `destroying`, `destroyed`, and `reconfiguring` in the full profile). A sync container is `ready` from the start, `failed` after a failed override, and `destroying` then `destroyed` once `destroy()` has begun.
- `constructs`, `initializes` and `disposes` count the operations that ended `ok`.
- `failures` counts the operations of any phase that ended with an error. An async step that fails counts twice, its construct and its initialize.
- `cancellations` counts the initializations cancelled with `initialize({ signal })`, counted when the signal aborts (`packages/core/src/generator/LifecycleEmitter.ts:615`; see [Async Factories](/guide/async-factories#cancelling-an-initialization)).
- `inFlight` counts the operations begun and not ended, per phase. A value that stays above zero is what is stuck.
- `activeScopes` counts the scopes made by `createScope()` and not destroyed yet: a scope leaves the count when it is marked closed (`packages/core/src/generator/LifecycleEmitter.ts:825`). A scope whose parent was destroyed is still counted until it is destroyed itself.

The counters belong to the container and its scopes together. They move whether or not a sink is subscribed, and the snapshot holds no graph and no reference to the application.

## Send the events to a trace system

The package has no tracing SDK. It has one small adapter, `observationChannel(channel)`, that forwards each event, as it is, to anything with `publish(message)`. A Node `diagnostics_channel` channel is one, and the package imports nothing from Node to say so. The adapter skips an event while the channel says it has no subscriber.

```typescript
import { channel } from 'node:diagnostics_channel';
import { observationChannel } from '@djodjonx/neosyringe';
import { container } from './container';

const stop = container.observe?.(observationChannel(channel('neosyringe')));
```

An OpenTelemetry bridge is a subscriber of that channel, in your application: it turns the `start` and `end` pair of an event into a span, and the `registrationId` and `phase` into attributes. Keep it bounded (a queue with a limit) and release it on shutdown; do not hold the container from a callback. A failure of the channel is not caught by the adapter, because the container already isolates every sink.

## Size and cost

A build that does not ask for the observation is the build that never heard of it: its text is byte for byte the same. A build that asks for it adds, to each container, one helper class, two public members, a few private ones, and for each creator a wrapper method and the body under a second name. An observed container keeps the creator of every class provider, so a class provider that the accessor of the full open profile would have built in place is built by its creator instead (`packages/core/src/generator/DirectEmitter.ts:341`).

The runtime bench measures the three modes. With `NEOSYRINGE_BENCH_OBSERVATION=off,on-no-subscriber,on-subscriber` it adds the observation axis to each case: the module sizes (`module.raw`, `module.min`, `module.gzip`) and every time metric are reported per mode, `on-subscriber` subscribing one sink that does nothing. No number is quoted on this page: the figures of a run are in [Qualification](/release/qualification#topic-22-optional-production-observation).

## What it does not do

- It sends nothing over a network and subscribes nothing on its own.
- A container with a `useContainer` parent reports its own operations only. The parent reports through its own `observe()`.
- The disposals of the rollback of a failed initialization are observed with the id of the registration they close (`packages/core/src/generator/LifecycleEmitter.ts:659`). A disposer that is looked up and refused (`NEO_*` protocol `TypeError`) is part of the failure the disposal reports, not an event of its own.
- A sync container has no initialization to observe: its first construct is the first `construct` event.
- The reference emitter writes the full surface for every profile, as it always did; only the optimized emitter, the default, gives the minimal profile its smaller surface.
