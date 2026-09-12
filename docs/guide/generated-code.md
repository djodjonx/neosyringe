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

## Zero Runtime Dependency

The generated container has **no import from `@djodjonx/neosyringe`**. It is plain TypeScript — no reflection, no metadata, no DI library in your bundle.

| | Traditional DI | NeoSyringe |
|---|---|---|
| Container library | 4–11 KB | 0 KB |
| `reflect-metadata` | ~3 KB | 0 KB |
| Generated container | N/A | ~50–200 lines |

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

Every generated container also has `override()` / `clearOverrides()`, meant for tests — not production wiring:

```typescript
container.override(useInterface<ILogger>(), () => mockLogger);
// every resolve() for that token now returns mockLogger (cached, like a singleton)

container.clearOverrides(); // revert to the real registrations
```

`destroy()` also clears overrides, so a container reused across tests doesn't leak one test's mocks into the next.

::: warning Disabled when `NODE_ENV=production`
`override()` throws if `process.env.NODE_ENV === 'production'`. A container is commonly a long-lived, shared singleton — an override left in by mistake, or reachable from somewhere it shouldn't be, would silently change what every caller gets for as long as the process runs. This is a deliberate guard, not an oversight — don't work around it by unsetting `NODE_ENV` in production.
:::

## Inspecting the Output

If you want to see exactly what was generated, look at the file after your build runs. With Vite, the output lands in `dist/`.
