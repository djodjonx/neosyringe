# Migrating to the Strict Contracts

How to move a consumer from the previous behaviour to the current one. This page is about NeoSyringe's own changes. To move a tsyringe or InversifyJS app to NeoSyringe, see [Legacy Migration](./legacy-migration.md).

::: warning Which version?
These changes are for the next major version. The destruction rule and the factory rule are not patch-level changes. No version number is fixed here.
:::

## What changed, and what to do

| Before | Now | What you do |
|--------|-----|-------------|
| `initialize()` only on some generated containers | `initialize()` is on every container (`CoreContainer`, `packages/neosyringe/src/types.ts:36`) | Await it before the first `resolve` when the graph has async work. Calling it on a sync container is harmless. |
| `destroy()` could serve as a reset | `destroy()` is final. Afterwards `resolve`, `initialize` and `createScope` throw `NEO_CONTAINER_DESTROYED` | Take scopes from a container you keep alive, and destroy the scope instead of the root. |
| `override` and `clearOverrides` used without waiting | Both return `Promise<void>` and reset all caches of that container | Add `await`. Drop objects resolved before the call. |
| Opaque factories (no `dependencies`) | `dependencies` is required, even `[]`. The build says `NEO_FACTORY_DEPENDENCIES_REQUIRED` | List every token the factory resolves. |
| A factory received the whole container | It receives a `FactoryContext`: `resolve` and `resolveAll` only | Move `initialize`, `destroy`, `override` and `createScope` calls out of factories. |
| Assuming a change in a parent rewires the child, or the reverse | A parent-owned service keeps the parent's dependencies | Register the consumer in the container whose dependency you changed. |
| `override` depended on a runtime check of `process` | It is a build option: `testOverrides: true`, refused when `NODE_ENV=production` | Set the plugin option in the test build. |
| An expression in `useValue` could be moved by generation | It is evaluated once where the configuration is evaluated, then shared by reference | Check expressions with effects. Use a factory for a value that is deferred or that differs per scope. |
| The whole API was available implicitly | `runtime: { profile: 'minimal' }` is opt-in and narrows the type | Keep `full` if you use events or overrides. |
| Tokens hashed with older rules | Versioned descriptors | Rebuild every package that shares tokens together. |
| A singleton could capture a disposable transient | A strict build fails with `NEO_DISPOSABLE_TRANSIENT_CAPTURED`. A singleton with `scoped: true` is included. A transient consumer is not | Register that service as a singleton, or construct it inside the singleton and close it from that service's `dispose`. |

The rows about `destroy`, `override`, factories, profiles and `useValue` are exercised by the executed example below and by [states and ownership](./states-and-ownership.md). The token-descriptor row is not executed here.

A disposable transient captured by a singleton is a breaking change for strict builds (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:74`). A singleton with `scoped: true` is included. A transient consumer is not. The remediation is the row above. The plugin has no escape hatch: it builds with `new Analyzer(program).extractAll()` and no options (`packages/unplugin/src/session.ts:559`), and `validation` only reaches the usage check (`packages/unplugin/src/index.ts:32`). The target is the next major (`docs/guide/migration.md:6`), the ADR004 rule. `validation: 'compatible'` warns only if you call the core analyzer yourself (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:301`). The CLI stays strict (`packages/cli/src/index.ts:105`).

## Before and after, executed

Both files below hold the four things the protocol below asks for: one singleton with a test override, one async factory, and one parent with its child. `tests/e2e/t20-migration.test.ts` runs both and requires the same result:

- the singleton: the same values, two disposals of the real `Database` (once when the override resets the container, once at `destroy()`), a mock that is never disposed, and `NEO_CONTAINER_DESTROYED` after `destroy()`;
- the async factory: `NEO_NOT_INITIALIZED` before `initialize()`, the same endpoint after it, one disposal of the client at `destroy()`, and `NEO_CONTAINER_DESTROYED` afterwards;
- the parent and child: the child reads the parent's `Logger`, destroying the child closes nothing in the parent (0 disposals), and destroying the parent closes its `Logger` once.

### Before

<<< @/../examples/new-api/migration-before.ts#container

<<< @/../examples/new-api/migration-before.ts#run

### After

<<< @/../examples/new-api/migration-after.ts#container

<<< @/../examples/new-api/migration-after.ts#run

The changes: `dependencies: [Database]` on the factory, and `await` on `override` and `clearOverrides`.

### What the default build does with the "before" file

With the default plugin options the legacy factory is refused:

```
NEO_FACTORY_DEPENDENCIES_REQUIRED: factory 'Report' requires a dependencies list.
```

Add the `dependencies` list first. That works with the old shape too, because the field is optional in the type (`packages/neosyringe/src/types.ts:223`), so it can ship before the upgrade.

### `validation: 'compatible'` does not rescue it in the plugin

The plugin option `validation` documents itself as driving only the usage check at the end of the build; the analyzer used to transform each file stays strict (`packages/unplugin/src/index.ts:34` to `:37`, and `packages/unplugin/src/session.ts:527`, where `new Analyzer(program)` gets no options). Running the plugin with `validation: 'compatible'` on the "before" file still fails with `NEO_FACTORY_DEPENDENCIES_REQUIRED`. `tests/e2e/t20-migration.test.ts` runs exactly that.

`validation: 'compatible'` is available when you call the analyzer yourself: `new Analyzer(program, { validation: 'compatible' })` from `@djodjonx/neosyringe-core/analyzer`. There the legacy factory becomes a warning (`NEO_FACTORY_DEPENDENCIES_REQUIRED: ... is opaque`), and the "before" file runs. The test uses that path for its "before" run. The `neosyringe-check` CLI has no option for it.

So there is no plugin-level transition mode on this revision. Declare the dependencies, then upgrade.

### What awaiting is for

If the old instance has an asynchronous `dispose`, a `resolve` placed right after an un-awaited `override` meets a container that is still reconfiguring:

```
NEO_CONTAINER_BUSY
```

`tests/e2e/t20-migration.test.ts` shows it (and that, after `await`, the resolve returns the mock and the old instance was closed once). With a synchronous `dispose`, as in the files above, the reconfiguration is already finished when `override` returns, so the missing `await` is silent. Add the `await` anyway: the type is a promise.

## Migration protocol

1. Write a small consumer on the previous version: one singleton, one async factory, one parent and child, one test override.
2. Install the new version.
3. Apply the table above: `dependencies`, `await`, `testOverrides`, scopes instead of `destroy()` as a reset.
4. Build, run the workflows, compare values and resources with step 1.
5. Only then, and as a separate change, consider [closed mode](./closed-mode.md).

::: warning The limit of the executed example
No archive of the previous release is installed in this repository. The "before" file is a consumer written in the legacy shape and run through the current generator in compatible mode. It proves what the documented changes keep. It is not a recording of the old package's output. Do step 1 on your own consumer with the real old archive before you trust a migration.
:::

## Open to closed is a second change

Do not combine it with the steps above. Declare the public roots and any service that must start (`eager`), then check the access you allowed and the bundle. `tests/e2e/t20-migration.test.ts` applies `optimization: { mode: 'closed', roots: [Report] }` to the `container` of the "after" file (the other containers stay open) and gets the same values and disposals. It also shows that resolving a non-root token from the same file fails the build with `NEO_ROOT_NOT_EXPORTED`.

A closed container requires `validation: 'strict'`. See [From Open to Closed](./closed-mode.md).

## Rolling back

Keep the previous archives and the lockfile. Roll back to a consistent set of packages. Mixing token schemes is not a safe rollback.
