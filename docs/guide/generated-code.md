# How It Works

What NeoSyringe does at build time — without reading generated code.

## The Transformation

Your `defineBuilderConfig()` call is replaced at build time with a generated container class. You never see or edit this code — it's handled entirely by the build plugin.

```typescript
// You write this
export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: ApiService }
  ]
});

// The build plugin replaces it with an optimized container class
// export const container = new NeoContainer(...);
```

## Token Resolution

NeoSyringe uses different comparison strategies depending on the token type:

| Token type | How it's stored | How it's compared |
|---|---|---|
| Interface (`useInterface<T>()`) | String ID derived from the type name | `token === "ILogger_abc123"` |
| Class | Reference to the class constructor | `token === ConsoleLogger` |
| Property (`useProperty<T>()`) | String ID bound to class + param name | `token === "PropertyToken:ApiService.apiUrl"` |

This is why `useInterface<T>()` is replaced at compile time — the string ID has to match at both the registration site and the resolve site.

## Singleton vs Transient

All services are singletons by default. The generated container caches each instance the first time it's created.

Transient services skip the cache and return a fresh instance on every `resolve()`.

## What ends up in your build

The plugin replaces the `defineBuilderConfig(...)` call with a generated container class, in the same file. The size of that class depends on your graph and on the [profile](./profiles.md). This page promises no size. A measured example, with its command, date and feature sets, is in the [profiles guide](./profiles.md#what-the-numbers-say-and-what-they-do-not).

## Debugging

The generated container exposes a few helpers for `_graph`/`_dependencyGraph`:

```typescript
// vite.config.ts / rollup.config.js / webpack.config.js / esbuild build script
neoSyringePlugin.vite({ debug: false })   // or .rollup(), .webpack(), .esbuild()
```

```json
// tsconfig.json (ts-patch, no bundler)
{ "transform": "@djodjonx/neosyringe-plugin/transformer", "debug": false }
```

This is a **build-time** decision, not a runtime check: when disabled, the token/dependency data is never written into the generated source at all — there's nothing for a bundler to dead-code-eliminate, which matters because ts-patch/plain-`tsc` builds have no bundler or minifier step to do that stripping for you. `container._graph` still exists either way (it just returns `[]` when disabled), so accessing it never breaks.

**Opt-in, not opt-out**: disabled by default — pass `{ debug: true }` explicitly to get `_graph`/`_dependencyGraph` data at all. This is deliberate: a project that never thinks about this option shouldn't silently carry the size/exposure cost of debug data it never asked for. On top of that, production **forces it off no matter what** — `{ debug: true }` in a production build is silently ignored. Both rules apply identically whether you use a bundler or ts-patch.

::: tip Not applicable to the [IDE Plugin](/guide/ide-plugin)
`debug` only affects the two entry points that actually generate a container (the bundler plugin and the ts-patch transformer). The LSP (`@djodjonx/neosyringe-lsp`) never generates one — it only analyzes your code to produce editor diagnostics — so adding `debug` to its `tsconfig.json` entry does nothing.
:::

```typescript
// List all registered token IDs
console.log(container._graph);
// ["ILogger_a1b2c3d4", "UserService_e5f6a7b8", ...]

// Same list, but with each token's own dependency edges — enough to render
// an actual dependency graph (DOT, mermaid, whatever you feed it into)
console.log(container._dependencyGraph);
// [{ token: "ILogger_a1b2c3d4", dependencies: [] },
//  { token: "UserService_e5f6a7b8", dependencies: ["ILogger_a1b2c3d4"] }]

// Error messages include the container name and a readable token name
// (a class token's declared name, or a string token with its hash suffix
// stripped — never the raw hash, and never a whole stringified class):
// [AppContainer] Service not found or token not registered: UnknownToken
```

### Overriding a registration in tests

The full profile has `override()` / `clearOverrides()`, meant for tests, not for production wiring. They work only in a build made with the plugin option `testOverrides: true`. Without it they reject with `NEO_TEST_API_DISABLED`. Both return promises: await them.

```typescript
await container.override(useInterface<ILogger>(), () => mockLogger);
// every later resolve() of that token returns mockLogger, and the consumers are rebuilt around it

await container.clearOverrides(); // back to the real registrations
```

- Each call resets **all** caches of that container. Services you resolved earlier keep their old dependencies: resolve them again.
- The mock is borrowed: the container does not dispose it.
- `destroy()` is terminal: the container cannot be reused. Create a scope per test with `createScope()`, and destroy that scope.
- The minimal profile has neither method. See [profiles](./profiles.md).

::: warning Refused when `NODE_ENV=production`
A build with `testOverrides: true` and `NODE_ENV=production` fails (`packages/core/src/generator/DebugConfig.ts:35`). The choice is made at build time: the generated code does not read `process`. Do not work around it by unsetting `NODE_ENV`.
:::

### Observing resolutions — `on('resolve', ...)`

The full profile has `on(event, listener)` for cross-cutting concerns — logging, tracing, timing how long a factory takes — without wrapping each factory by hand. Unlike `override()`, it needs no test flag and is meant for production use too (e.g. wiring into your own tracing/APM), not just tests:

```typescript
const unsubscribe = container.on('resolve', (token, instance) => {
  console.log('resolved', token, '→', instance);
});

container.resolve(UserService); // triggers the listener above

unsubscribe(); // stop listening
```

- Fires on **every successful `resolve()`**, regardless of where the instance actually came from — a fresh factory call, a cached singleton, an `override()`, or delegation to a `useContainer` parent/legacy container.
- Multiple listeners can be registered independently; each returns its own unsubscribe function.
- A listener that throws is caught and ignored — a bug in an observability hook must never break the resolution it's observing, and it doesn't stop other listeners from running.

`'resolve'` is currently the only event.

## Inspecting the Output

If you want to see exactly what was generated, look at the file after your build runs. With Vite, the output lands in `dist/`.
