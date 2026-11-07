# Migrating to the Strict Contracts

How to move a consumer from the previous behaviour to the current one. This page is about NeoSyringe's own changes. To move a tsyringe or InversifyJS app to NeoSyringe, see [Legacy Migration](./legacy-migration.md).

::: warning Which version?
These changes are for the next major version. The destruction rule and the factory rule are not patch-level changes. No version number is fixed here.
:::

## What changed, and what to do

| Before (historical npm, `pnpm migration:historical`) | Now | What you do |
|--------|-----|-------------|
| A sync container has no initialize method. An async container throws the LegacyAsync message quoted under the protocol, from initialize and from a resolve. No client was created, because initialize() threw | `initialize()` is on every container (`CoreContainer`, `packages/neosyringe/src/types.ts:36`) | Await it before the first `resolve` when the graph has async work. Calling it on a sync container is harmless. |
| Calling destroy and then resolve raised no error. The probed close count was 1, and that 1 is the FakeDatabase mock from the direct-read probe (`scripts/ci/historical-migration.mjs:94`). The plain BEFORE consumer printed `disposed 0` (`scripts/ci/historical-migration.mjs:532`). The real Database leaks on override | `destroy()` is final. Afterwards `resolve`, `initialize` and `createScope` throw `NEO_CONTAINER_DESTROYED` | Take scopes from a container you keep alive, and destroy the scope instead of the root. |
| Historical override replaced only the overridden token; the already cached Report kept the real Database; the direct resolve printed fake (`scripts/ci/historical-migration.mjs:533`) | Both return `Promise<void>` and reset all caches of that container | Add `await`. Drop objects resolved before the call. |
| Opaque factories (no `dependencies`). Not run on the historical archive | `dependencies` is required, even `[]`. The build says `NEO_FACTORY_DEPENDENCIES_REQUIRED` | List every token the factory resolves. |
| A factory received the whole container. Not run on the historical archive | It receives a `FactoryContext`: `resolve` and `resolveAll` only (`packages/neosyringe/src/types.ts:94-97`). This row names no error code | Move `initialize`, `destroy`, `override` and `createScope` calls out of factories. |
| Assuming a change in a parent rewires the child, or the reverse. Not run on the historical archive | A parent-owned service keeps the parent's dependencies | Register the consumer in the container whose dependency you changed. |
| The historical plugin options do not mention testOverrides or validation. override depended on a runtime check of `process`. The run printed `override checks process.env.NODE_ENV: yes` (`scripts/ci/historical-migration.mjs:469`) | It is a build option: `testOverrides: true`, refused when `NODE_ENV=production`. The run printed `NEO_TEST_API_DISABLED: testOverrides cannot be enabled when NODE_ENV is production` (`packages/core/src/generator/DebugConfig.ts:35`) | Set the plugin option in the test build. |
| An expression in `useValue` could be moved by generation. Not run on the historical archive | It is evaluated once where the configuration is evaluated, then shared by reference | Check expressions with effects. Use a factory for a value that is deferred or that differs per scope. |
| The whole API was available implicitly. Not run on the historical archive | `runtime: { profile: 'minimal' }` is opt-in and narrows the type | Keep `full` if you use events or overrides. |
| Historical CLI 0.4.1 has no tokens-manifest flag. Both producers were `@acme/tokens` with entry src/tokens.ts. This run's historical producer key was `User_547bb74f`. It differs from the candidate key | Versioned descriptors. The candidate producer and the candidate consumer both printed `User_4c3940c5` and the consumer returned `{"value":"same","syncInitialize":"function"}` | Rebuild every package that shares tokens together. |
| A singleton could capture a disposable transient. Not run on the historical archive | A strict build fails with `NEO_DISPOSABLE_TRANSIENT_CAPTURED`. A singleton with `scoped: true` is included. A transient consumer is not | Register that service as a singleton, or construct it inside the singleton and close it from that service's `dispose`. |

The rows about `destroy`, `override`, factories, profiles and `useValue` are exercised by the executed example below and by [states and ownership](./states-and-ownership.md). The token-descriptor row was executed by `pnpm migration:historical` (local, exit 0). A candidate consumer of a historical producer that depends on `@djodjonx/neosyringe` and ships no manifest printed `NEO_TOKEN_BOUNDARY_UNSUPPORTED: manifest-absent @acme/tokens User` (`packages/core/src/analyzer/shared/tokensManifest.ts:330-334`). The same run's candidate producer and candidate consumer, with a manifest, shared `User_4c3940c5`. Both producers were `@acme/tokens` with entry src/tokens.ts (`scripts/ci/historical-migration.mjs:842`). `historical key differs from candidate key: yes`. `same key across the rebuild: no`.

A disposable transient captured by a singleton is a breaking change for strict builds (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:74`). A singleton with `scoped: true` is included. A transient consumer is not. The remediation is the row above. The plugin has no escape hatch: it builds with `new Analyzer(program).extractAll()` and no options (`packages/unplugin/src/session.ts:559`), and `validation` only reaches the usage check (`packages/unplugin/src/index.ts:32`). The target is the next major (`docs/guide/migration.md:6`), the ADR004 rule. `validation: 'compatible'` warns only if you call the core analyzer yourself (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:301`). The CLI stays strict (`packages/cli/src/index.ts:105`).

## Before and after, executed

Both files below hold the four things the protocol below asks for: one singleton with a test override, one async factory, and one parent with its child. `tests/e2e/t20-migration.test.ts` runs both against the candidate and requires the same result. The historical archives do not. `pnpm migration:historical` printed the BEFORE cells for initialize, destroy, override, the plugin options and the token row. It did not run the opaque-factory, parent-rewiring, `useValue`, implicit-API or disposable-transient rows on the historical archive. Those Before cells are marked in the table.

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

::: warning What `pnpm migration:historical` printed
The command is opt-in (`package.json:14`). It installs the historical pins in a temp directory outside the repo and does not publish. One local run on 2026-11-07 exited 0. This page does not cite a CI run of the job.

Each build ran in a child process whose cwd was that project (`scripts/ci/historical-migration.mjs:851`). The block `builds read nothing under the repo` printed `under the repo: 0` for every build. The BEFORE behaviour numbers did not change when that build stopped using the monorepo tsconfig. The historical key did change: an earlier run quoted `User_2579db41`, which followed the temp directory. This run printed `User_547bb74f`.

BEFORE (historical npm) behaviour:

```
syncInitialize "undefined"
real "report from real"
mocked "report from real"
overriddenDirect "fake"
restored "report from real"
disposed 1
afterDestroy "no error"
asyncBeforeInit, asyncEndpoint and asyncAfterDestroy: [LegacyAsync] This container has async services — call `await container.initialize()` before the first resolve().
asyncClosed 0
sharedLogger true
childLine "parent handled"
parentClosedAfterChild 0
parentClosedAfterParent 1
testOverrides mentioned: no
validation mentioned: no
--tokens-manifest in dist/index.mjs: no
historical producer: User_547bb74f
plain consumer, no direct read: disposed 0
```

`disposed 1` counts the FakeDatabase mock. The direct-read probe (`scripts/ci/historical-migration.mjs:94`) resolves Database after override, and destroy closes that mock. The plain BEFORE consumer, without the probe, printed `disposed 0` (`scripts/ci/historical-migration.mjs:532`). The real Database leaks on override. `initializeError` was printed and then excluded from the comparison (`scripts/ci/historical-migration.mjs:526`), because the AFTER `run()` does not return that key (`examples/new-api/migration-after.ts:144`).

`run()` was rejected with that same LegacyAsync message, inside `initialize()`. No client was created.

AFTER (candidate tarballs) behaviour, with `testOverrides: true`: `mocked` `"report from fake"`, `disposed` 2, `afterDestroy` `NEO_CONTAINER_DESTROYED`, `asyncBeforeInit` `NEO_NOT_INITIALIZED`, `asyncEndpoint` `"/api"`, `asyncClosed` 1, `asyncAfterDestroy` `NEO_CONTAINER_DESTROYED`, `syncInitialize` `"function"`. The other keys stayed equal (`real`, `restored`, `sharedLogger`, `childLine`, `parentClosedAfterChild`, `parentClosedAfterParent`, `overriddenDirect` `"fake"`). The comparison printed `declared` for the eight differences and `equal` for the rest.

The candidate also printed `NEO_FACTORY_DEPENDENCIES_REQUIRED` for the legacy factory under strict validation and under `validation: 'compatible'`, `NEO_DISPOSABLE_TRANSIENT_CAPTURED` for a singleton that captures a disposable transient, and `{"during":"NEO_CONTAINER_BUSY","after":"fake","closed":1,"syncInitialize":"function"}` when `override` was not awaited. Script note, not an observation: the FactoryContext block is the constant string `no code asserted: the guide row does not name one, and this script does not invent one` (`scripts/ci/historical-migration.mjs:666`). Closed mode was not run: `not run here. Closed mode stays on tests/e2e/t20-migration.test.ts` (`tests/e2e/t20-migration.test.ts:106`).
:::

## Open to closed is a second change

Do not combine it with the steps above. Declare the public roots and any service that must start (`eager`), then check the access you allowed and the bundle. `tests/e2e/t20-migration.test.ts` applies `optimization: { mode: 'closed', roots: [Report] }` to the `container` of the "after" file (the other containers stay open) and gets the same values and disposals. It also shows that resolving a non-root token from the same file fails the build with `NEO_ROOT_NOT_EXPORTED`.

A closed container requires `validation: 'strict'`. See [From Open to Closed](./closed-mode.md).

## Rolling back

Keep the previous archives and the lockfile. Roll back to a consistent set of packages. Mixing token schemes is not a safe rollback.
