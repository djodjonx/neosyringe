# Profiles and Capabilities

A generated container comes in two profiles. The profile is chosen in the configuration, and the TypeScript type of the container tells you which methods exist.

## The two profiles

| Profile | Type | Methods |
|---------|------|---------|
| `full` (default) | `Container` | `resolve`, `resolveAll`, `initialize`, `destroy`, `createScope`, `override`, `clearOverrides`, `on` |
| `minimal` (opt-in) | `CoreContainer` | `resolve`, `resolveAll`, `initialize`, `destroy`, `createScope` |

Types: `CoreContainer` at `packages/neosyringe/src/types.ts:18`, `Container` at `packages/neosyringe/src/types.ts:53`, `ContainerFor` at `packages/neosyringe/src/types.ts:135`.

<<< @/../examples/new-api/profiles.ts#profiles

- Minimal drops the test overrides and the `resolve` event. It does not drop resource handling: `initialize`, `destroy` and the isolation of scopes stay.
- `override` and `on` are **absent from the minimal type**: `minimal.override(...)` does not compile (`Property 'override' does not exist on type 'CoreContainer'`), and at run time `override` is `undefined`. Both are checked in `tests/e2e/t20-docs-examples.test.ts`.
- `createScope()` returns the same profile (`this`).
- Pick `full` when you need events or overrides.

### The profile must be a literal

`runtime: { profile: 'minimal' }` is read by the build and by the type. If the profile is not a literal the build can decide (a variable, a call), the build fails with `NEO_CONFIG_UNSUPPORTED` instead of guessing.

## Test overrides

`override` and `clearOverrides` exist in the type of the full profile, but they work only if the build enabled them:

| Plugin option | Effect |
|---------------|--------|
| `testOverrides` omitted or `false` | `override()` and `clearOverrides()` reject with `NEO_TEST_API_DISABLED`. |
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

The heavy provider is **synthetic**: the script generates a class with 500 methods that return seeded literals, and registers it so that no root reaches it. It is built to make the pruning visible. A real unused provider can be smaller or larger, and its content changes how well it compresses. The `open - closed` row is the open bundle minus the closed bundle. It mixes two changes: the heavy provider that the closed mode removes, and the emitter that the closed mode switches to (the optimized emitter is used when the mode is `closed`, `packages/core/src/generator/Generator.ts:201-203`; the open bundle uses the reference emitter). The container table above shows that the emitter alone moves the sizes (+662 raw, +1303 minified for the full profile). So the delta is not the size of the sentinel alone, and it is not what the closed mode removes from your application. Initial and deferred chunks are not measured.

The bundle byte counts depend on the absolute path of the build: the file name is hashed into the container id (`packages/core/src/analyzer/shared/HashUtils.ts:158-160`) and into the generated class suffix (`packages/core/src/generator/Generator.ts:150-154`). The script builds in a fixed directory per checkout, so one checkout prints the same bytes at every run. Another checkout or a CI machine can print other bytes: on 2026-11-06, changing the build directory name from `t17-size-bundle` to `t17-size-bundle-<10 hex>` moved the raw size of both bundles by +110 bytes (open 59596 to 59706, closed 30456 to 30566). The test of the script asserts no exact byte count.

The script reads `packages/core/dist` and `packages/unplugin/dist`, so run it after a fresh `pnpm build`. Its header documents the same limit (`scripts/measure-t17-size.mjs:7`).

Build-time and runtime speed are not measured on this page. The cost of compiling a project has its own method, machine and run, in `docs/benchmarks/T18-compilation-cost.md` (command `pnpm bench:compile`). Do not mix its numbers with the tables above.
