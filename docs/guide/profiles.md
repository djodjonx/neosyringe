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

No page of this documentation promises a size or speed gain. The only measurement we publish is from this command, run on 2026-11-06:

```bash
node scripts/measure-t17-size.mjs
```

It generates the container for one fixed graph (12 chained factories, 3 `multi` contributions, 1 async singleton, open mode, debug off, `testOverrides` off), transpiles it, and minifies it with esbuild. The result is the size of the generated container only, not of an application bundle.

| Variant | Raw bytes | Minified bytes | Raw vs reference | Minified vs reference |
|---------|-----------|----------------|------------------|-----------------------|
| `reference-full` | 79594 | 32747 | - | - |
| `optimized-full` | 80256 | 34050 | +662 | +1303 |
| `optimized-minimal` | 58965 | 26635 | -20629 | -6112 |

Read it like this:

- `optimized-full` is **larger** than `reference-full` for this graph. No gain is claimed for it.
- `optimized-minimal` is smaller than `reference-full`, but it is a **different feature set** (no overrides, no events). The script says so itself. Do not read that row as a free speed-up.
- One graph, one run, no dispersion. Another graph can give other numbers.
- Build-time and runtime speed are not measured on this page.

The script reads `packages/core/dist`, so run it after a fresh `pnpm build`. Its header documents the same limit (`scripts/measure-t17-size.mjs:4`).
