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

The generated container exposes a few helpers, all stripped by dead-code elimination when `NODE_ENV === 'production'`:

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

## Inspecting the Output

If you want to see exactly what was generated, look at the file after your build runs. With Vite, the output lands in `dist/`.
