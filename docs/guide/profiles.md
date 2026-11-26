# Profiles and Capabilities

A generated container comes in two profiles. The profile is chosen in the configuration, and the TypeScript type of the container tells you which methods exist.

## The two profiles

| Profile | Type | Methods |
|---------|------|---------|
| `full` (default) | `Container` | `resolve`, `resolveAll`, `resolveMany`, `initialize`, `destroy`, `createScope`, `override`, `overrideMany`, `clearOverrides`, `on` |
| `minimal` (opt-in) | `CoreContainer` | `resolve`, `resolveAll`, `resolveMany`, `initialize`, `destroy`, `createScope` |

Types: `CoreContainer` at `packages/neosyringe/src/types.ts:18`, `Container` at `packages/neosyringe/src/types.ts:73`, `ContainerFor` at `packages/neosyringe/src/types.ts:265`.

<<< @/../examples/new-api/profiles.ts#profiles

- Minimal drops the test overrides and the `resolve` event. It does not drop resource handling: `initialize`, `destroy` and the isolation of scopes stay.
- `override`, `overrideMany` and `on` are **absent from the minimal type**: `minimal.override(...)` does not compile (`Property 'override' does not exist on type 'CoreContainer'`), and at run time `override` is `undefined`. The absence of `override` and `on` is checked in `tests/e2e/t20-docs-examples.test.ts`. The absence of `overrideMany` is checked in `tests/consumer-types/negative/override-many.ts` (type) and by E16-P6b in `packages/core/tests/generator/e16-override-many-runtime.test.ts` (run time).
- `createScope()` returns the same profile (`this`).
- Pick `full` when you need events or overrides.

### With scope inputs

A builder with `scopeInputs` returns a `ContainerTemplate` of its profile, and each scope is a `BoundContainer` of that profile: `full` has `override`, `overrideMany`, `clearOverrides` and `on` on the scope, `minimal` has the `CoreContainer` members only (`packages/neosyringe/src/types.ts:239`). The template has `createScope` and `destroy` in both. See [ContainerTemplate and BoundContainer](/api/types#containertemplate-and-boundcontainer).

### The profile must be a literal

`runtime: { profile: 'minimal' }` is read by the build and by the type. If the profile is not a literal the build can decide (a variable, a call), the build fails with `NEO_CONFIG_UNSUPPORTED` instead of guessing.

## Test overrides

`override`, `overrideMany` and `clearOverrides` exist in the type of the full profile, but they work only if the build enabled them:

| Plugin option | Effect |
|---------------|--------|
| `testOverrides` omitted or `false` | `override()`, `overrideMany()` and `clearOverrides()` reject with `NEO_TEST_API_DISABLED`. |
| `testOverrides: true` | They work. |
| `testOverrides: true` and `NODE_ENV=production` | The build refuses (`packages/core/src/generator/DebugConfig.ts:35`). |

The choice is made at build time. The generated code does not read `process`. See [the mock example](./scoped-injections.md#testing-with-mocks) and [migration](./migration.md).

An override replaces a **singleton**, and it is awaited:

```typescript
await container.override(loggerToken, () => new FakeLogger());
const service = container.resolve(Service);   // rebuilt around the fake
await container.clearOverrides();
```

Every override and every `clearOverrides()` resets all caches of that container. Objects you resolved before keep pointing at the old dependencies: drop them. The mock is borrowed and is never disposed by the container. `override` of a `multi` token rejects with `NEO_OVERRIDE_MULTI_UNSUPPORTED`.

`overrideMany([[tokenA, factoryA], [tokenB, factoryB]])` replaces several tokens in one transition. The whole batch is checked first: a token twice (`NEO_OVERRIDE_DUPLICATE`), a factory that is not a function (`NEO_OVERRIDE_INVALID`) or a `multi` token refuses it, and then no factory is invoked, nothing is disposed and nothing changes. A valid batch runs one cleanup pass, so each owned singleton is disposed once, then installs every mock together. The mocks are borrowed. An async container needs `initialize()` again, as after `override`. An empty batch is checked against the state of the container and changes nothing. While one transition runs, a second `override`, `overrideMany` or `clearOverrides` rejects with `NEO_CONTAINER_BUSY`, and so do `destroy()` and `resolve()`.

A factory that returns another type than its token is a compile error, with the public `Container` type and with the Program the ts-patch transformer builds (`tests/consumer-types/negative/override-many.ts`, E16-P17 and E16-P18 in `packages/unplugin/tests/t23-inline-types.test.ts`). One limit: with `testOverrides` off, the generated member is `overrideMany(_entries: unknown)`, as `override(_token: unknown, _factory)` is. On the transformed Program of such a build, a wrong factory return compiles, and the call still rejects with `NEO_TEST_API_DISABLED` at run time.

## What the numbers say, and what they do not

No page of this documentation promises a size or speed gain. The only measurement we publish is from this command, run on 2026-11-06 with Node `v22.23.2`:

```bash
node scripts/measure-t17-size.mjs
```

It has two parts. The first generates the container for one fixed graph (12 chained factories, 3 `multi` contributions, 1 async singleton, open mode, debug off, `testOverrides` off), transpiles it, and minifies it with esbuild. That is the size of the generated container only, not of an application bundle. The second bundles a small application with the real plugin and esbuild in production mode, once open and once closed, and compares the two.

Gzip is level 9 and Brotli is quality 11. Both compress the **minified** text.

| Variant | Raw bytes | Minified bytes | Gzip bytes | Brotli bytes | Raw vs reference | Minified vs reference |
|---------|-----------|----------------|------------|--------------|------------------|-----------------------|
| `reference-full` | 79594 | 32747 | 3669 | 2973 | - | - |
| `optimized-full` | 80256 | 34050 | 3951 | 3172 | +662 | +1303 |
| `optimized-minimal` | 58965 | 26635 | 3271 | 2676 | -20629 | -6112 |

Read it like this:

- `optimized-full` is **larger** than `reference-full` for this graph, raw, minified, gzip and Brotli. No gain is claimed for it.
- `optimized-minimal` is smaller than `reference-full`, but it is a **different feature set** (no overrides, no events). The script says so itself. Do not read that row as a free speed-up.
- One graph, one run, no dispersion. Another graph can give other numbers.

### Open and closed bundle

The application is `tests/e2e/fixtures/t21-closed/app.ts`. The closed bundle uses `optimization: { mode: 'closed', roots: [pipeline], eager: [worker] }`. The open bundle is the same sources without that option. Both are executed and return the same result.

| Bundle | Raw bytes | Minified bytes | Gzip bytes | Brotli bytes | Carries the heavy provider |
|--------|-----------|----------------|------------|--------------|----------------------------|
| open | 59706 | 37646 | 12653 | 9908 | yes |
| closed | 30566 | 15706 | 3241 | 2842 | no |
| open - closed | 29140 | 21940 | 9412 | 7066 | |

The heavy provider is **synthetic**: the script generates a class with 500 methods that return seeded literals, and registers it so that no root reaches it. It is built to make the pruning visible. A real unused provider can be smaller or larger, and its content changes how well it compresses. The `open - closed` row is the open bundle minus the closed bundle. It mixes two changes: the heavy provider that the closed mode removes, and the emitter that the closed mode switches to (the optimized emitter is used when the mode is `closed`, `packages/core/src/generator/Generator.ts:202-204`; the open bundle uses the reference emitter). The container table above shows that the emitter alone moves the sizes (+662 raw, +1303 minified for the full profile). So the delta is not the size of the sentinel alone, and it is not what the closed mode removes from your application. Initial and deferred chunks of this cjs bundle are not split. The esbuild ESM split is measured in [Initial and deferred chunks](#initial-and-deferred-chunks).

The bundle byte counts depend on the absolute path of the build: the file name is hashed into the container id (`packages/core/src/analyzer/shared/HashUtils.ts:158-160`) and into the generated class suffix (`packages/core/src/generator/Generator.ts:151-155`). The script builds in a fixed directory per checkout, so one checkout prints the same bytes at every run. Another checkout or a CI machine can print other bytes: on 2026-11-06, changing the build directory name from `t17-size-bundle` to `t17-size-bundle-<10 hex>` moved the raw size of both bundles by +110 bytes (open 59596 to 59706, closed 30456 to 30566). The test of the script asserts no exact byte count.

The script reads `packages/core/dist` and `packages/unplugin/dist`, so run it after a fresh `pnpm build`. Its header documents the same limit (`scripts/measure-t17-size.mjs:7`).

Build-time and runtime speed are not measured on this page. The cost of compiling a project has its own method, machine and run, in `docs/benchmarks/T18-compilation-cost.md` (command `pnpm bench:compile`). Do not mix its numbers with the tables above.

## Initial and deferred chunks

The cjs rows above do not split a bundle into chunks. This command does, for one esbuild ESM bundle. It was run on 2026-11-06:

```bash
node scripts/measure-chunk-split.mjs
```

The script printed: Node `v22.23.2`, zlib `1.3.1-e00f703`, `Darwin 27.2.0 darwin`, `Apple M4 Max x16`, esbuild `0.27.2`, TypeScript `5.9.3`, `@djodjonx/neosyringe` `0.3.0`. Gzip is level 9 and Brotli is quality 11. Both compress the minified text. esbuild only. Rollup is not used. `scripts/ci/consumer-dist.mjs` is a CI check, not this measure.

The container stays in the initial chunk. One synthetic heavy provider (500 generated methods) is reached only through a dynamic import, so its bytes are a deferred chunk. The static control uses a top-level import and has no deferred chunk. Open omits `optimization`. Closed sets `optimization: { mode: 'closed', roots: [port] }`. Full omits `runtime`. Minimal sets `runtime: { profile: 'minimal' }`. Each raw build and each minified build was executed. All five returned `{"tag":"CHUNK_SPLIT_HEAVY","marker":"CHUNK_SPLIT_CONTAINER"}`.

| Scenario | Role | Raw bytes | Minified bytes | Gzip bytes | Brotli bytes |
|----------|------|-----------|----------------|------------|--------------|
| `open-full` | initial | 16814 | 8237 | 2404 | 2128 |
| `open-full` | deferred | 29546 | 22481 | 8698 | 7072 |
| `open-minimal` | initial | 11044 | 6162 | 2020 | 1769 |
| `open-minimal` | deferred | 29546 | 22481 | 8698 | 7072 |
| `closed-full` | initial | 16397 | 8260 | 2440 | 2144 |
| `closed-full` | deferred | 29546 | 22481 | 8698 | 7072 |
| `closed-minimal` | initial | 11338 | 6362 | 2098 | 1843 |
| `closed-minimal` | deferred | 29546 | 22481 | 8698 | 7072 |
| `control-static` | initial | 42658 | 28605 | 11115 | 8713 |

The deferred row is the same in the four split cells: that provider does not change with the profile or the mode. `closed-full` is 16397 raw against `open-full` 16814 raw, and 8260 minified against 8237 minified. No gain is claimed. Minimal is a different feature set. The optimized emitter is used when the profile is minimal or the mode is closed (`packages/core/src/generator/Generator.ts:202-204`). The bytes depend on the absolute build path (`packages/core/src/analyzer/shared/HashUtils.ts:157-160`, `packages/core/src/generator/Generator.ts:151-155`) and on the Node zlib version (gzip). One synthetic provider, one machine, no threshold. The method is in [the chunk-split note](../benchmarks/chunk-split-size.md).
