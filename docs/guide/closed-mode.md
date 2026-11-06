# From Open to Closed

A container is **open** by default. You can opt in to **closed** mode when you want the build to keep only what your public entry points need.

::: tip Source of the examples
Every snippet on this page is included from `examples/new-api/`. `tests/e2e/t20-docs-examples.test.ts` bundles those files with the real esbuild plugin and runs them.
:::

## What each mode keeps

| Mode | Declared with | What the generated container keeps |
|------|---------------|-------------------------------------|
| Open (default) | nothing, or `optimization: { mode: 'open' }` | **Every registration.** |
| Closed | `optimization: { mode: 'closed', roots, eager? }` | Each root, each `eager` service, and everything those need. |

An open container keeps every registration. Nothing is removed because no caller resolves it, and nothing on this page promises otherwise. A registration disappears only when you ask for it: you declare a closed container and name its roots.

The default is also the safe one. A container file with few `resolve()` calls does not become closed by itself.

## Step 1 and step 2 are separate changes

Move to the new version first, with the container still open. Check that the results and the resources are the same. See the [migration guide](./migration.md). Only then change `mode`. If both changes land together, a regression has two possible causes.

## A closed container

<<< @/../examples/new-api/closed.ts#container

The five tokens play different parts:

| Token | Part | Result |
|-------|------|--------|
| `pipeline` | root | The only token callers may `resolve()`. |
| `middleware` | multi contribution of the `{ all: middleware }` dependency | Both contributions stay. `pipeline` reads them with `context.resolveAll`. |
| `worker` | `eager` | Started once by `initialize()`. It is not public. |
| `report` | unreachable | Absent from the generated container. |
| `banner` | unreachable, but its `useValue` expression has an effect | See [Effects](#effects). |

### Roots

`roots` lists what the outside may ask for. A simple root is a token. A multi root is `{ all: token }`.

- `resolve(token)` is accepted for simple roots only. `resolveAll(token)` is accepted for `{ all: token }` roots only.
- A call that the build can see outside the roots fails the build with `NEO_ROOT_NOT_EXPORTED`.
- A call that the build cannot see (dynamic access, JavaScript) reaches a guard in the generated container. It throws an error whose `code` is `NEO_ROOT_NOT_EXPORTED` (`packages/core/src/generator/Generator.ts:671`, covered by `packages/core/tests/generator/t17-direct-profiles.test.ts:840`).
- A dependency that a root needs stays in the container but is not public. Factories reach it through the `context`, because it is in their `dependencies`.
- `override()` of a token that is not a root is accepted in a closed container, and so is `override()` of a token that was pruned. The plan for the next major asked for a refusal. Main has no root check on the override path (`packages/core/src/generator/LifecycleEmitter.ts:537` to `:545`). `tests/e2e/t20-docs-examples.test.ts` calls both.

### Eager services

`eager` keeps a service and starts it even if no root needs it. This is how a background service survives the move to closed mode. In the example, `workerStarts` is 1 after two calls to `initialize()`.

An async singleton that is neither reachable from a root nor `eager` is **not started** in closed mode. In open mode `initialize()` starts all of them. If a service used to start only because it was registered, list it in `eager`.

### Multi

A root `{ all: token }` keeps every contribution of the token and the dependencies of each one. `resolve(token)` on a multi token is `NEO_MULTI_REQUIRES_RESOLVE_ALL`, at build time when visible.

### Effects

A `useValue` expression runs where the configuration is evaluated, once. Pruning the provider does not remove that evaluation. In the example, `stamp(...)` runs once (`bannerStamps` is 1), and the same call is not re-run per `resolve()` or per scope. Put a value that must differ per scope in a factory.

The registration is absent from the container, but a module-level effect is kept. Do not rely on a closed container to drop a side effect that lives in the expression or in an imported module. Backing tests: `tests/e2e/t20-docs-examples.test.ts` ("closed example"), `packages/core/tests/generator/t16-closed-runtime.test.ts:625` and `:651`.

### Parent boundaries

<<< @/../examples/new-api/closed-parent.ts#containers

- A closed child reaches its parent through the tokens its factories declare in `dependencies`.
- The parent here is open, so the whole parent stays: `ParentOnly` is still in the bundle. The child's usage does not prune the inside of a parent. The test bundles this file and checks that `ParentOnly` stays and `ChildOnly` is gone.
- A parent that is itself closed must export the tokens its children use as roots.

## What closed mode requires

- `validation: 'strict'`. Closed mode with `validation: 'compatible'` is `NEO_CLOSED_REQUIRES_STRICT` (`packages/core/src/analyzer/parsers/ConfigParser.ts:792`).
- Every factory declares `dependencies`. An opaque factory in a closed container is `NEO_FACTORY_DEPENDENCIES_REQUIRED`.
- `mode` written as the string literal `'open'` or `'closed'` (`packages/core/src/analyzer/parsers/ConfigParser.ts:582`). `mode: 'open'` with `roots` or `eager` is `NEO_CONFIG_UNSUPPORTED` (`packages/core/src/analyzer/parsers/ConfigParser.ts:606`).
- Validation still covers the registrations that were pruned: a duplicate, a cycle or a missing provider is reported even if the provider is not kept.

## See why something was kept

```bash
npx neosyringe-check --explain UserService
npx neosyringe-check --retention-report retention.json
```

Both flags are listed in the usage text at `packages/cli/src/report.ts:35` and `:37`. See the [CLI guide](./cli.md).

## Measurements

This page makes no size promise for closed mode. The only numbers published are in the [profiles guide](./profiles.md), with their command, date and feature sets.
