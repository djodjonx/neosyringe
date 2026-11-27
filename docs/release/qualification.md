# Final qualification of the corrections program (T21)

This is the delivery dossier. It prepares a release. It does not publish one.

## Status in one view

- Nothing is published, merged or deployed by this work. The version bumps are made by the release-please pull request (#32 when this was written, as given in the task brief). They are not edited here (`release-please-config.json`, `.release-please-manifest.json`).
- Base commit: `bf23efa` (the head of `main` when the work started).
- Candidate: the working tree of the pull request head, without the results of this page. A commit cannot cite its own sha, so the sha is not written here.
- Node `v22.23.2` and pnpm `10.19.0` ran every local command (`package.json:48`). The platform is macOS (Darwin 27.2.0).
- Each command row has one status: `local`, `remote CI (run id N)`, or `not executed`.
- The only remote CI run cited is `42218196764`. It ran on the base commit `bf23efa`. It is not a result of the candidate. Its conclusion is `failure`: the job "Test (Node 22)" failed on one test that timed out after 5000 ms (`packages/unplugin/tests/t06-usages.test.ts`, test "T06-A05 alias and unknown target"). The other jobs of that run succeeded, except the aggregator "Required checks", which fails when a needed job fails. This was read with `gh run view 42218196764` on 2026-11-06.
- The CI run id of the pull request is cited by the pull request body. This page cannot cite its own CI run.
- One docs edit is outside the dossier: `docs/guide/profiles.md:87` now points to `docs/benchmarks/T18-compilation-cost.md`, the placeholder that T20 left for T18.

## Versions

The versions below are read from `packages/*/package.json`. A test compares this table with the files.

| Package | Directory | Version |
|---------|-----------|---------|
| `@djodjonx/neosyringe` | `packages/neosyringe` | `0.3.0` |
| `@djodjonx/neosyringe-core` | `packages/core` | `3.2.0` |
| `@djodjonx/neosyringe-plugin` | `packages/unplugin` | `0.6.1` |
| `@djodjonx/neosyringe-cli` | `packages/cli` | `0.4.1` |
| `@djodjonx/neosyringe-lsp` | `packages/lsp` | `0.4.6` |
| `@djodjonx/neosyringe-ui` | `packages/ui` | `0.2.1` |
| `neosyringe-vscode` | `packages/vscode-extension` | `0.2.0` |

- `neosyringe-vscode` is private. It is not an npm package (`packages/vscode-extension/package.json:8`).
- These are the current versions. The six npm packages have the versions of the tarballs that `pnpm pack` made in the `node scripts/ci/consumer-dist.mjs` run below.
- The next versions are not decided here. The release-please pull request decides them.
- The next major is the target. `docs/guide/migration.md:5-6` says the destruction rule and the factory rule are not patch-level changes, and that no number is fixed.
- Mixing package versions is not supported for tokens: rebuild the packages that share tokens together (`docs/guide/migration.md:22`).

## Changelog proposal

This is text only. It is not written into any `CHANGELOG.md`. Those files belong to release-please.

The source is `git log bf23efa~21..bf23efa`, the 21 merged commits T00 to T20 (pull requests #31 and #33 to #52). A package is listed when the commit touched its directory (`git diff-tree`). "Breaking" marks a row of the migration table (`docs/guide/migration.md:11-22`).

### `@djodjonx/neosyringe-core`

- Breaking. `06cec7a` (T09, #46): resources are owned, disposed and scoped explicitly, with a terminal `destroy` and `createScope` (the words of its subject).
- Breaking. `4ac260c` (T10, #47): `override` and `clearOverrides` reset the caches of the container and return a promise. `testOverrides` is a build option.
- Breaking. `3ad0be1` (T05, #39): factory dependencies are validated in the graph. A factory receives a limited context.
- `2ddfadb` (T17, #49): direct per-registration access and explicit full and minimal profiles. The minimal profile is opt-in (`docs/guide/migration.md:21`).
- Breaking. `c8be9d5` (T02, #37): token identity is canonical. A collision is an error, not silent.
- `a324a56` (T15, #45): token manifests are published between packages. The distribution is qualified.
- `f20cab3` (T16, #48): the closed optimization mode with roots, eager roots and graph pruning.
- `d4c149a` (T07, #43): one shared async initialization and an explicit container state machine.
- `79e5409` (T08, #44): each multi contribution has its own state, cache key and disposal.
- `cfc9347` (T06, #42): `resolve` and `resolveAll` are validated against the container each call targets.
- `a6f51ed` (T04, #38): one constructor signature and one registration graph for both analysis paths.
- `fc0bbb9` (T19, #50): stable diagnostic codes, a retention report and an explain command.
- `33dc374` (T14, #36), `f997f0f` (T01, #35), `d02a5da` (T11, #40) and `c2bb025` (T03, #34) also touch this package.

### `@djodjonx/neosyringe-plugin`

- `f997f0f` (T01, #35): markers are recognised by symbol provenance, not by name.
- `33dc374` (T14, #36): generated containers and `definePartialConfig` calls carry PURE annotations.
- `d02a5da` (T11, #40): one compilation session for the plugin, the transformer and the CLI.
- `86cba45` (T12, #41): the devtools registry is per container and file, and serve-only.
- `bf23efa` (T18, #52): tsconfig invalidation by content, caches per plugin instance, a compile-cost benchmark.
- `f20cab3` (T16, #48), `4ac260c` (T10, #47), `cfc9347` (T06, #42), `3ad0be1` (T05, #39) and `c8be9d5` (T02, #37) also touch this package.

### `@djodjonx/neosyringe`

- `c2bb025` (T03, #34): the public container types match the generated capabilities.
- Breaking. `06cec7a` (T09, #46): see the core entry above.
- `a324a56` (T15, #45): see the core entry above.

### `@djodjonx/neosyringe-cli`

- `fc0bbb9` (T19, #50): `--retention-report` and `--explain`.
- `a324a56` (T15, #45): token manifest output.
- `f997f0f` (T01, #35) and `d02a5da` (T11, #40) also touch this package.

### `@djodjonx/neosyringe-lsp`

- `fc0bbb9` (T19, #50): the stable code is carried in the message.
- `a6f51ed` (T04, #38), `3ad0be1` (T05, #39), `cfc9347` (T06, #42) and `c8be9d5` (T02, #37) also touch this package.

### `@djodjonx/neosyringe-ui`

- `86cba45` (T12, #41): the graph serialization keeps container keys, multi nodes and borrowed registrations.
- `fc0bbb9` (T19, #50): retention causes and paths are serialized.

### `neosyringe-vscode`

- No commit of the range touches this package.

### No package

- `790e1cf` (T00, #31): audit baseline, reproduction scripts and the e2e harness.
- `1be8750` (T13, #33): e2e, consumer types and distribution checks run in CI. The release is gated.
- `455011e` (T20, #51): guides, examples and the migration page match the implemented contracts.

## Migration

The full guide is `docs/guide/migration.md`. The table below only names what breaks.

| Before | Now | Executed by |
|--------|-----|-------------|
| `destroy()` could serve as a reset | `destroy()` is final | `tests/e2e/t21-integrated.test.ts::T21-A01 destroy is terminal, owned disposed once, borrowed parent value untouched` |
| `override` and `clearOverrides` without `await` | Both return a promise and reset all caches of that container | `tests/e2e/t21-integrated.test.ts::T21-A01 awaited override shows the mock, clearOverrides rebuilds the original` |
| Opaque factories | `dependencies` is required | `tests/e2e/t20-migration.test.ts::T20-A06 the default strict plugin refuses the legacy factory with NEO_FACTORY_DEPENDENCIES_REQUIRED` |
| Factories received the whole container | They receive `FactoryContext` | `tests/e2e/t20-docs-examples.test.ts::a factory may resolve only what it declares, and only while it runs` |
| Open containers only | Closed mode is a second, separate change | `tests/e2e/t20-migration.test.ts::T20-A06 step 2 only: the same candidate turned closed keeps the values and the disposals` |

`pnpm migration:historical` (`package.json:14`) ran locally on 2026-11-07 and exited 0. It is opt-in. No unit suite calls it. The CI job `historical-migration` (`.github/workflows/ci.yml:149-165`) checks out, sets up Node 22, runs `pnpm build`, then `pnpm migration:historical`, with `continue-on-error: true` and `timeout-minutes: 20`. It is not in `required.needs` (`.github/workflows/ci.yml:171`, `tests/ci/workflows.test.ts:202`). This page does not cite a CI run of that job. Each build ran in a child process whose cwd was that project (`scripts/ci/historical-migration.mjs:851`). The block `builds read nothing under the repo` printed `under the repo: 0` for every build.

The script printed `publish: no`. Installed pins: `@djodjonx/neosyringe` 0.3.0, `@djodjonx/neosyringe-plugin` 0.6.1, `@djodjonx/neosyringe-core` 3.2.0, `@djodjonx/neosyringe-ui` 0.2.1. `cli installed: no`. `lsp installed: no`. CLI 0.4.1 was packed only, and the script printed `--tokens-manifest in dist/index.mjs: no`.

BEFORE (historical npm) behaviour:

```
syncInitialize "undefined"
mocked "report from real"
overriddenDirect "fake"
disposed 1
afterDestroy "no error"
asyncBeforeInit, asyncEndpoint, asyncAfterDestroy: [LegacyAsync] This container has async services — call `await container.initialize()` before the first resolve().
asyncClosed 0
plain consumer, no direct read: disposed 0
```

`disposed 1` counts the FakeDatabase mock. The direct-read probe (`scripts/ci/historical-migration.mjs:94`) resolves Database after override, and destroy closes that mock. The plain BEFORE consumer, without the probe, printed `disposed 0` (`scripts/ci/historical-migration.mjs:532`). The real Database leaks on override. No client was created: `initialize()` threw the LegacyAsync message.

Historical override replaced only the overridden token; the already cached Report kept the real Database; `overriddenDirect` printed fake (`scripts/ci/historical-migration.mjs:533`). override depended on a runtime check of `process`. The run printed `override checks process.env.NODE_ENV: yes` (`scripts/ci/historical-migration.mjs:469`).

`real`, `restored`, `sharedLogger`, `childLine`, `parentClosedAfterChild`, `parentClosedAfterParent` and `overriddenDirect` matched the candidate (`"report from real"`, `true`, `"parent handled"`, 0, 1, `"fake"`). AFTER (candidate tarballs) printed `mocked` `"report from fake"`, `disposed` 2, `afterDestroy` `NEO_CONTAINER_DESTROYED`, `asyncBeforeInit` `NEO_NOT_INITIALIZED`, `asyncEndpoint` `"/api"`, `asyncClosed` 1, `asyncAfterDestroy` `NEO_CONTAINER_DESTROYED`, `syncInitialize` `"function"`. The comparison printed `declared` on those eight keys and `equal` on the rest.

The candidate pack lines said each tarball carries the disk build. The sha256 block (`scripts/ci/historical-migration.mjs:600`) showed that the declaration file of `@djodjonx/neosyringe`, the module of `@djodjonx/neosyringe-plugin`, the generator module of `@djodjonx/neosyringe-core` and the module of `@djodjonx/neosyringe-ui` differed. The module of `@djodjonx/neosyringe` was the same hash on both sides (`1c72b827c7ce6a175c0b79329d5111e4c7d1a39e442920dd3d2022f413643486`). Version checks do not prove the candidate: the run printed `version check proves the candidate: no`. Both installs printed `nested @djodjonx packages: 0`.

The candidate printed `NEO_FACTORY_DEPENDENCIES_REQUIRED` for factory `Report` with the default strict plugin and again with `validation: 'compatible'`. It printed `NEO_DISPOSABLE_TRANSIENT_CAPTURED` for container `Cap`. An override that was not awaited printed `{"during":"NEO_CONTAINER_BUSY","after":"fake","closed":1,"syncInitialize":"function"}`. Production `testOverrides` printed `NEO_TEST_API_DISABLED: testOverrides cannot be enabled when NODE_ENV is production` (`packages/core/src/generator/DebugConfig.ts:35`). Script note, not an observation: the FactoryContext block is the constant string `no code asserted: the guide row does not name one, and this script does not invent one` (`scripts/ci/historical-migration.mjs:666`). `FactoryContext` exposes `resolve`, `resolveAll` and `resolveMany` only (`packages/neosyringe/src/types.ts:297-314`). Closed mode printed `not run here. Closed mode stays on tests/e2e/t20-migration.test.ts` (`tests/e2e/t20-migration.test.ts:106`).

The token row printed BEFORE producer key `User_547bb74f`. An earlier run quoted `User_2579db41`, which followed the temp directory. This run's producers were both `@acme/tokens` with entry src/tokens.ts (`scripts/ci/historical-migration.mjs:842`). The candidate consumer of the historical package, which depends on `@djodjonx/neosyringe` and ships no manifest, printed `NEO_TOKEN_BOUNDARY_UNSUPPORTED: manifest-absent @acme/tokens User` (`packages/core/src/analyzer/shared/tokensManifest.ts:330-334`). The candidate-built producer and the candidate consumer printed `producer key: User_4c3940c5`, `consumer key: User_4c3940c5`, `resolved: {"value":"same","syncInitialize":"function"}`. The last token block printed `historical key differs from candidate key: yes` and `same key across the rebuild: no`.

## Support matrix

"Exercised" means a test or a command ran it. Nothing else is claimed.

| Item | What ran | Status |
|------|----------|--------|
| Node 20 | CI matrix (`.github/workflows/ci.yml:15`) | Not executed locally. Node 20 passed on the base run `42218196764`, not on the candidate. |
| Node 22 | Local `v22.23.2`. CI matrix (`.github/workflows/ci.yml:15`) and the e2e job (`.github/workflows/ci.yml:67`) | Local. The base run `42218196764` failed on Node 22 with a test timeout, see above. |
| Node 24 | Nothing | Not executed. |
| TypeScript | `5.9.3` (`consumer-dist` output, lockfile). The peer range is `>=5.0.0` (`packages/unplugin/package.json:40`) | Only `5.9.3` is exercised. The lower bound of the range is not tested. |
| esbuild | `0.27.2` (`packages/unplugin/package.json:49`), real bundles in `tests/e2e/t21-closed-bundle.test.ts` and `scripts/ci/consumer-dist.mjs` | Local. |
| Rollup | `4.55.2` (`packages/unplugin/package.json:50`), `tests/e2e/t16-elagage.test.ts::T16-A01 rollup` and `scripts/ci/consumer-dist.mjs` | Local. |
| Vite | Vite `8.3.6` (`packages/unplugin/package.json:54`). Real `vite build`, library mode, format `cjs`, mode `production`, `build.write: false`, on this machine (Node v22.23.2). `tests/e2e/t22-real-bundlers.test.ts::T22 vite open bundle returns names and keeps the sentinel`, `tests/e2e/t22-real-bundlers.test.ts::T22 vite closed bundle drops the sentinel and runs the effect`, `tests/e2e/t22-real-bundlers.test.ts::T22 vite build rejects NEO_MISSING_PROVIDER` | Local. No CI run of this build. |
| webpack | webpack `5.112.2` (`packages/unplugin/package.json:56`). Real `webpack()`, mode `production`, target `node`, `library.type` `commonjs2`, esbuild TypeScript loader (`tests/e2e/helpers/esbuild-ts-loader.cjs`, same call as `tests/e2e/t16-elagage.test.ts:137`), Node v22.23.2. `tests/e2e/t22-real-bundlers.test.ts::T22 webpack open bundle returns names and keeps the sentinel`, `tests/e2e/t22-real-bundlers.test.ts::T22 webpack closed bundle drops the sentinel and runs the effect`, `tests/e2e/t22-real-bundlers.test.ts::T22 webpack compile fails with NEO_MISSING_PROVIDER` | Local. No CI run of this build. The missing-provider failure is the compiler callback error from the throw at `packages/unplugin/src/index.ts:177`. This run received no `stats` object. |
| Rspack | Rspack `2.3.1` (`packages/unplugin/package.json:48`). Real `rspack()`, mode `production`, target `node`, `library.type` `commonjs2`, esbuild TypeScript loader (`tests/e2e/helpers/esbuild-ts-loader.cjs:11`), Node v22.23.2. Plugin entry `neoSyringePlugin.rspack` (`packages/unplugin/src/index.ts:71`) comes from `createUnplugin` of unplugin (`packages/unplugin/src/index.ts:1`). `tests/e2e/t22-real-bundlers.test.ts::T22 rspack open bundle returns names and keeps the sentinel`, `tests/e2e/t22-real-bundlers.test.ts::T22 rspack closed bundle drops the sentinel and runs the effect`, `tests/e2e/t22-real-bundlers.test.ts::T22 rspack compile fails with NEO_MISSING_PROVIDER` | Local. No CI run of this build. |
| TypeScript transformer | `packages/unplugin/tests/t11-pipeline.test.ts::T11-P12-transformer-root-parity` and `packages/unplugin/tests/t14-pure.test.ts::T14-P7b-transformer` | Local, through the package suites. |
| Linux | `ubuntu-latest` (`.github/workflows/ci.yml:12`) | Remote CI only, base run `42218196764`. |
| macOS | The machine of the local runs | Local. |
| Windows | No run. `packages/unplugin/tests/t11-pipeline.test.ts::T11-P5-id-query-windows` passes Windows-style ids to the plugin on a Unix machine. | Not exercised. Not certified. |
| VS Code extension | Not built or run by T21 | Not executed. |

## Measurements

Each number says its workload, features, versions and metric. A number from an older page is not a result of the candidate.

| Measurement | Workload and features | Result | Status |
|-------------|-----------------------|--------|--------|
| Size of one generated container | `node scripts/measure-t17-size.mjs`, Node `v22.23.2`. 12 chained factories, 3 multi contributions, 1 async singleton, open mode, debug off, `testOverrides` off. Raw and minified (esbuild) bytes. Gzip level 9 and Brotli quality 11, both on the minified text. | Raw / minified / gzip / Brotli. `reference-full` 79594 / 32747 / 3669 / 2973. `optimized-full` 80256 / 34050 / 3951 / 3172. `optimized-minimal` 58965 / 26635 / 3271 / 2676. | Local. Same numbers as `docs/guide/profiles.md`. |
| Open vs closed bundle | `node scripts/measure-t17-size.mjs`, same run. `tests/e2e/fixtures/t21-closed/app.ts` plus a generated heavy provider (500 methods, synthetic), real plugin, esbuild, production. Both bundles are executed and return the same result. Gzip level 9 and Brotli quality 11 on the minified text. | Raw / minified / gzip / Brotli. Open 59706 / 37646 / 12653 / 9908. Closed 30566 / 15706 / 3241 / 2842. Open minus closed 29140 / 21940 / 9412 / 7066. | Local. Open minus closed is the removed heavy provider plus the emitter change of the closed mode (`packages/core/src/generator/Generator.ts:210-212`), not the sentinel alone, and not what an application would gain. The bundle bytes depend on the absolute build path, so another checkout or CI can print other bytes (`docs/guide/profiles.md`). Initial and deferred chunks of this cjs output are not split. The esbuild ESM split is the next row. |
| ESM initial and deferred chunks | `node scripts/measure-chunk-split.mjs`, run on 2026-11-06. Node `v22.23.2`, zlib `1.3.1-e00f703`, Darwin 27.2.0 darwin, Apple M4 Max x16. esbuild 0.27.2, TypeScript 5.9.3, `@djodjonx/neosyringe` 0.3.0. Open/closed × full/minimal, plus a static-import control. Real plugin and esbuild (`splitting: true`, `format: 'esm'`). One synthetic heavy provider (500 methods) loaded with a dynamic import. Gzip level 9 and Brotli quality 11 on the minified text. Each raw build and each minified build was executed. All five returned `{"tag":"CHUNK_SPLIT_HEAVY","marker":"CHUNK_SPLIT_CONTAINER"}`. | Raw / minified / gzip / Brotli. open-full initial 16814 / 8237 / 2404 / 2128, deferred 29546 / 22481 / 8698 / 7072. open-minimal initial 11044 / 6162 / 2020 / 1769, deferred 29546 / 22481 / 8698 / 7072. closed-full initial 16397 / 8260 / 2440 / 2144, deferred 29546 / 22481 / 8698 / 7072. closed-minimal initial 11338 / 6362 / 2098 / 1843, deferred 29546 / 22481 / 8698 / 7072. control-static initial 42658 / 28605 / 11115 / 8713, no deferred chunk. | Local. esbuild only. Rollup is not used. `scripts/ci/consumer-dist.mjs` is a CI check, not this measure. The bytes depend on the absolute build path and on the Node zlib version (gzip). Full table in `docs/benchmarks/chunk-split-size.md`. |
| Compile cost, size 10 | `NEOSYRINGE_BENCH_SIZES=10 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs`. Node `v22.23.2`, TypeScript 5.9.3, Apple M4 Max, Darwin 27.2.0, 1 warm-up and 5 runs. | linear, plugin, `first_ms` median. open: full 13.7 ms and 109040 bytes, minimal 9.2 ms and 58120 bytes. closed: full 9.9 ms and 104420 bytes, minimal 8.6 ms and 60310 bytes. | Local. One machine, `load1` about 2 before the run, no claim of a gain. Min and max, all 16 cells and the other metrics are in `docs/benchmarks/T18-compilation-cost.md`. |
| Compile cost, size 100 | Same command with `NEOSYRINGE_BENCH_SIZES=100`. Same session and machine. | linear, plugin, `first_ms` median. open: full 78.8 ms and 1091120 bytes, minimal 56.9 ms and 582100 bytes. closed: full 69.5 ms and 1045460 bytes, minimal 63.2 ms and 604090 bytes. | Local. Same reserves. |
| Compile cost, size 1000 | Same command with `NEOSYRINGE_BENCH_SIZES=1000`. Same session and machine. | linear, plugin, `first_ms` median. open: full 572.8 ms and 10919120 bytes, minimal 544.5 ms and 5830900 bytes. closed: full 582.6 ms and 10468460 bytes, minimal 560.5 ms and 6051790 bytes. | Local. Same reserves. |
| Compile cost, size 5000 | `NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_REPS=5 NEOSYRINGE_BENCH_SHAPES=<shape> NEOSYRINGE_BENCH_PROFILES=<profile> NEOSYRINGE_BENCH_MODES=<mode> NODE_OPTIONS=--max-old-space-size=8192 node tests/bench/compile-cost.mjs`, one command per (shape, profile, mode), 8 commands, all 16 cells ran. Same session and machine. | linear, plugin, `first_ms` median. open: full 2949.4 ms and 54631120 bytes, minimal 2865.5 ms and 29198900 bytes. closed: full 3046.3 ms and 52404460 bytes, minimal 2941.7 ms and 30307790 bytes. | Local. The four `diamond` commands ran while another process loaded the machine (`load1` up to 33.52): read them as indicative. They were not rerun. |
| Runtime bundle of the public package | `node scripts/ci/consumer-dist.mjs`. Bound `3072` bytes. | esbuild 232 bytes, rollup 1374 bytes. | Local. |

- The T17 table compares variants with different feature sets. The minimal row has no overrides and no events. Do not read it as a free gain (`docs/guide/profiles.md`).
- Compile cost has its own method and machine in `docs/benchmarks/T18-compilation-cost.md`. Do not add it to the size table.
- The closed bundle test shows that the unreachable sentinel is absent from the code and from the modules that put bytes in the output. It does not measure a size gain: the size delta comes from `scripts/measure-t17-size.mjs` (row Open vs closed bundle), not from that test.

## NS001-NS017

Each row names the tests that prove it. Each cell is `file::test name`. A test checks that every name exists in its file. The body of every listed test was read before it was listed.

| NS | Finding | Tests | What the tests assert |
|----|---------|-------|-----------------------|
| NS001 | Generic tokens collided | `tests/e2e/t02-identite.test.ts::T02-A01 Repo<User> et Repo<Order> renvoient chacun leur valeur`<br>`tests/e2e/t15-token-manifest.test.ts::producer token keeps key in consumer` | Executed code returns `{ user: 'user', order: 'order' }`. A producer token keeps its runtime key in a consumer. |
| NS002 | Inherited constructor | `tests/e2e/t04-graphe.test.ts::T04-A01 Derived sans constructeur reçoit le logger` | Executed code: a class without its own constructor receives the logger of its base. |
| NS003 | Factories outside the graph | `packages/core/tests/analyzer/t05-factories.test.ts::missing factory dep is NEO_MISSING_PROVIDER`<br>`packages/core/tests/analyzer/t05-factories.test.ts::self capture is NEO_UNDECLARED_FACTORY_DEP` | A factory dependency that is not registered is a build error with its code. A factory that resolves a captured container is refused. |
| NS004 | Validation against the wrong container | `packages/core/tests/analyzer/t06-usages.test.ts::T06-A01 token in A resolved in independent B`<br>`tests/e2e/t06-usages.test.ts::T06 strict build rejects resolve of a missing token on a known container` | The error names the container B, its file and its call. A resolve of a missing token on a known container fails the build with `NEO_MISSING_PROVIDER`. |
| NS005 | Async factory could not resolve during initialize | `packages/core/tests/generator/t05-factory-runtime.test.ts::async factory reads sync config during initialize` | After `initialize()` the async host holds the value read from the sync config. |
| NS006 | Concurrent initialize | `packages/core/tests/generator/t07-initialisation-runtime.test.ts::T07-A02 concurrent initialize calls the factory once`<br>`tests/e2e/t21-integrated.test.ts::T21-A01 concurrent initialize runs the async factory once` | Twelve concurrent calls run the factory once. A `resolve` during the work throws `NEO_NOT_INITIALIZED`. In the integrated scenario five containers start together and the async factory starts once. |
| NS007 | Async multi and destruction | `packages/core/tests/generator/t08-multi-runtime.test.ts::T08-P1 [A01] async multi initialize returns ready objects`<br>`packages/core/tests/generator/t08-multi-runtime.test.ts::T08-P9 [A06] destroy disposes created multi singletons once` | Ready objects after `initialize()`. Each created multi singleton is disposed once, also on a second `destroy()`. |
| NS008 | Override cache | `packages/core/tests/generator/t10-overrides-runtime.test.ts::T10-P1 clearOverrides drops the mock cache (class singleton and value)`<br>`packages/core/tests/generator/t10-overrides-runtime.test.ts::T10-P2 dependents rebuilt` | After `clearOverrides()` the real value comes back. A consumer is rebuilt around the mock and again around the original. |
| NS009 | Parent semantics and mocks | `tests/e2e/t20-docs-examples.test.ts::T20-A02 mock example: the consumer sees the mock, the parent-owned consumer keeps the real dependency`<br>`packages/core/tests/generator/t09-scope-runtime.test.ts::T09-P8 parent semantics` | A parent-owned service keeps the parent's logger. A child that registers its own logger gets its own. |
| NS010 | Public types incomplete | `tests/e2e/t03-public-types.test.ts::T03-A01 historical audit-types consumer has zero diagnostics`<br>`tests/e2e/t03-public-types.test.ts::T03-A05 async factory unwraps to Client` | The historical consumer compiles with zero diagnostics. An async factory resolves to its awaited type, and a wrong one is rejected. |
| NS011 | `useProperty` marker left at run time | `tests/e2e/t01-symboles.test.ts::T01-P4-property-const`<br>`packages/unplugin/tests/t01-symboles.test.ts::T01-P4b-tokens-file`<br>`packages/unplugin/tests/t11-pipeline.test.ts::T11-P3-alias-namespace-property` | The original case runs and resolves the value. A dedicated tokens file and an aliased or namespace import leave no `useProperty(` or `useInterface(` call in the output, and the output runs. |
| NS012 | Markers recognised by name | `tests/e2e/t01-symboles.test.ts::T01-P1-alias`<br>`tests/e2e/t01-symboles.test.ts::T01-P3-homonym` | An aliased `defineBuilderConfig` is transformed and runs. A local function with the same name is left alone. |
| NS013 | Devtools without a graph | `packages/unplugin/tests/t12-devtools.test.ts::T12-A01 devtools lists the container` | The registry is empty before the transform, then holds the container with its tokens. |
| NS014 | E2E and integration proof | `tests/ci/workflows.test.ts::T13-A01 e2e after build`<br>`tests/ci/workflows.test.ts::T15 distribution runs consumer-dist after check-dist`<br>`tests/ci/tarball-proof.test.ts::T21-A03 a tarball whose dist differs from the disk build is refused`<br>`tests/e2e/t21-integrated.test.ts::T21-A01 the pinned expectation file equals the executed report`<br>`tests/e2e/runtime-positive.test.ts::T13-A02 parent-only class resolves through the child` | The e2e job builds first, must not continue on error, and runs on Node 22. The distribution job runs `check-dist` then `consumer-dist`. The consumer-on-tarball proof refuses a tarball whose dist differs from the disk build. The report of the integrated scenario equals the pinned file that `scripts/ci/consumer-dist.mjs` compares with the report of the installed tarballs. The e2e suite runs the generated code. The `consumer-dist` command also ran locally, see the commands table. |
| NS015 | Performance promises | `tests/e2e/t20-docs-examples.test.ts::T20-NS015 the profiles guide cites the measurement command, its date and its feature sets`<br>`packages/core/tests/generator/t17-direct-profiles.test.ts::T17-A05 minimal profile does not export on/override and carries neither maps nor branches` | The profiles page cites the command, the date and "different feature set". The minimal profile removes only `on`, `override` and `clearOverrides`, with their maps and branches. A guard in the same test file refuses pages that promise a free runtime. |
| NS016 | Scopes and resources | `packages/core/tests/generator/t09-scope-runtime.test.ts::T09-P6 scopes`<br>`tests/e2e/t21-integrated.test.ts::T21-A01 parent value keeps identity, child scopes share the parent singleton` | Scopes have their own local singletons and share the parent's. Closing a scope does not close the parent. |
| NS017 | Tree shaking | `tests/e2e/t16-elagage.test.ts::T16-A01 esbuild`<br>`tests/e2e/t21-closed-bundle.test.ts::T21-A04 closed bundle drops the unreachable sentinel and keeps the required effect`<br>`tests/e2e/t21-closed-bundle.test.ts::T21-A04 the executed bundle runs the effect once and starts the eager root` | A closed bundle has no sentinel of an unreachable provider. The module of that provider puts no bytes in the output. The required effect is present, runs once, and the eager root starts once. |

A contractual refusal is not used as a proof for any NS row. The refusals of the program are listed in `docs/guide/states-and-ownership.md` and are checked by `tests/e2e/t20-docs-examples.test.ts`.

## Remaining limits

- Nothing is published, merged or deployed. This page prepares a release.
- Strict validation follows `createScope()` to the same container (`packages/core/src/analyzer/collectors/resolutionUsages.ts:149`). The integrated scenario builds with `validation: 'strict'` (`tests/e2e/t21-integrated.test.ts:53`). Closed mode still needs its own roots, so the closed container stays a separate fixture, `tests/e2e/fixtures/t21-closed/app.ts`.
- The plugin keeps a bare import of the module of a pruned provider (`packages/core/src/generator/Generator.ts:201-205`). esbuild still lists that module under `metafile.inputs`. It lists no bytes of it under `metafile.outputs`. The closed bundle test checks the outputs.
- Disposable detection reads a `dispose` call signature (`packages/core/src/analyzer/parsers/InjectionParser.ts:602`), then a method keyed by the `Symbol.asyncDispose` or `Symbol.dispose` of the program's lib, compared as a type and never as text (`packages/core/src/analyzer/parsers/InjectionParser.ts:617`). A class token uses the instance type (`packages/core/src/analyzer/parsers/InjectionParser.ts:554-555`). An interface or property token uses `T` (`packages/core/src/analyzer/parsers/InjectionParser.ts:571`). A transient factory uses the return type when that type has `dispose`, otherwise the token type (`packages/core/src/analyzer/parsers/InjectionParser.ts:539`, `packages/core/src/analyzer/parsers/InjectionParser.ts:543`). `any` and `unknown` are not disposable (`packages/core/src/analyzer/parsers/InjectionParser.ts:597`). A static-only `dispose` stays silent. `ownership: 'borrowed'` on a transient does not lift the refusal (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:81`). `validation: 'compatible'` warns only in the core analyzer (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:304`). The plugin and the CLI stay strict (`packages/unplugin/src/session.ts:561`, `packages/cli/src/index.ts:105`).
- The bundlers and platforms marked "Not exercised" in the support matrix are not certified.
- Initial and deferred chunks are distinguished for one esbuild ESM bundle (`node scripts/measure-chunk-split.mjs`, `docs/benchmarks/chunk-split-size.md`). Raw, minified, gzip level 9 and Brotli quality 11 are recorded per chunk. Gzip bytes depend on the Node zlib build. The initial chunk holds the container. The deferred chunk holds one synthetic heavy provider (500 methods) reached by a dynamic import. The static control has no deferred chunk. That meets the size part of the tree-shaking item (10-definition-termine.md, line 30 of the spec folder) for this esbuild case: the four costs are recorded, and initial and deferred chunks are told apart. It does not cover Rollup, any other bundler, or a real provider. `scripts/ci/consumer-dist.mjs` is a CI check, not this measure. The cjs bundles of `scripts/measure-t17-size.mjs` are still single outputs (`scripts/measure-t17-size.mjs:158`).
- Compile cost at size 5000, shape `diamond` (4 commands, 8 rows) is indicative: those commands ran while `load1` went up to 33.52 and were not rerun. The groups of size 10, 100 and 1000 and the four size 5000 `linear` groups started with `load1` between 1.94 and 2.73; the four size 5000 `diamond` groups started between 2.43 and 31.08. The machine was shared. A rerun on a quiet machine is needed before relying on these numbers.
- The migration from historical npm archives was run locally by `pnpm migration:historical` (exit 0, see Migration). The CI job is opt-in and not in `required.needs`. This page does not cite a CI run of that job.
- Coverage thresholds are set per package in `packages/*/vitest.config.ts`. This work did not change a threshold.
- The base CI run failed on Node 22 with one 5000 ms timeout, see Known issues. The candidate must be judged on its own CI run, which this page does not cite.

## Known issues

- The base CI run `42218196764` (base commit `bf23efa`) failed in the job "Test (Node 22)", step "Test with coverage". The test "T06-A05 alias and unknown target" (`packages/unplugin/tests/t06-usages.test.ts:225`) took 5129 ms, over the 5000 ms limit. Source: `gh run view 42218196764 --log-failed`, read on 2026-11-06. This failure comes from an earlier task (T06), not from T21.
- This pull request changes that test file so the test is cheaper: the temporary project sets `lib: ['ES2020']` and `types: []` (`packages/unplugin/tests/t06-usages.test.ts:53-56`), so each plugin instance parses fewer library files. No assertion changed. Local measure of that one test, with coverage on, two runs each: 1003 ms and 976 ms before, 255 ms and 248 ms after. Without coverage, one run: 166 ms before, 83 ms after. These are local numbers on one machine. The fix has not run on CI, so nothing here says the run will pass.
- Defect from an earlier task (T05 and T08). It is fixed. A factory of a child container that listed `{ all: token }` for a multi token of its open parent was refused by the build with the message "Missing injection ... is not registered" (code `NEO_MISSING_PROVIDER`, `packages/core/src/generator/GraphValidator.ts:83`). ADR002 (spec folder, line 7) allows `{ all: token }` as a dependency entry, and ADR002 (line 33) asks the validation to use the effective view: local, parent, and public roots when closed. The closed-parent path already copied the exported multi roots (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:215-216`). The open-parent path copied only `parentGraph.nodes` (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:138`). An `{ all }` entry keeps the plain token id (`packages/core/src/analyzer/parsers/InjectionParser.ts:818`), and the validator checks it against that set (`packages/core/src/generator/GraphValidator.ts:77`, `packages/core/src/generator/GraphValidator.ts:100`). At run time `child.resolveAll` already worked (`packages/core/tests/generator/t08-multi-runtime.test.ts::T08-P12 [A07] child delegates or shadows the parent multi list`). The fix is `fix(core): resolve { all } of an open parent multi token in child factories` (base `720e9f1`). The open-parent path now adds each `parentGraph.multiNodes` id to `graph.parentProvidedTokens` (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:154`). `tests/e2e/t08-child-all-open-parent.test.ts::T08-ALL-1 open parent {all} resolves ['auth','log']` builds, and the executed code resolves `['auth', 'log']`.
- CI run `42348348123` (base commit `fd50180`) failed in the job "Test (Node 22)", step "Test with coverage". The test "should pass validation for valid configuration" (`packages/cli/tests/cli.test.ts:27`) hit the 5000 ms limit (`Test timed out in 5000ms`). Source: `gh run view 42348348123 --log-failed`, read on 2026-11-07. On that run the other tests of the same file took 1924 ms to 2759 ms. Each test built a new program with default options, so the default library was parsed again, including `lib.dom.d.ts`. A local count of that program is 7 declaration files and 2070 KB. The same count with `lib: ['ES2020']` and `types: []` is 45 declaration files and 425 KB, and `lib.dom.d.ts` is absent. `packages/core/src/analyzer/Analyzer.ts:305` and `packages/core/src/analyzer/Analyzer.ts:316` skip declaration files, so the graph still comes from the fixture. This change parses each declaration file once on one shared host (`packages/cli/tests/cli.test.ts:28-46`) and passes those options through `convertCompilerOptionsFromJson` (`packages/cli/tests/cli.test.ts:14-20`). No assertion changed. In this tree the same test is `packages/cli/tests/cli.test.ts:54`. Local measure of the file, with coverage on, three runs: duration 6.82 s, 5.76 s and 5.88 s before, and 727 ms, 730 ms and 734 ms after. The slowest test was 742 ms, 488 ms and 496 ms before, and 148 ms, 146 ms and 145 ms after. These are local numbers on one machine. The fix ran on CI in run `42350823516` (commit `ccedfb6`). All 8 jobs passed. In the job "Test (Node 22)", the file `packages/cli/tests/cli.test.ts` took 2246 ms and the test "should pass validation for valid configuration" took 1350 ms, where it took 5359 ms before. In the job "Test (Node 20)", the file took 1742 ms and that test 1079 ms. Source: `gh run view 42350823516 --log`, read on 2026-11-07. These are CI numbers of one run.

## Commands run

Rows 1 to 9 below are the T21 runs. They were run on the T21 tree, base `bf23efa`, before the open-parent fix. They do not describe the current tree. Each row was run in the foreground, one at a time, from the repo root, and written after its run. Node `v22.23.2`, pnpm `10.19.0`, macOS (Darwin 27.2.0).

| # | Command | Status | Exit | Result |
|---|---------|--------|------|--------|
| 1 | `pnpm build` | local | 0 | All seven `packages/* build` jobs report `Done` (neosyringe, core, lsp, ui, vscode-extension, cli, unplugin). |
| 2 | `pnpm lint` | local | 0 | `Found 1763 warnings and 0 errors.` 357 files, 90 rules. No warning in a file of this work. |
| 3 | `pnpm typecheck` | local | 0 | `tsc --noEmit` printed no diagnostic. The tests are inside this check (`tsconfig.json` includes `tests`). |
| 4 | `pnpm test` | local | 0 | 848 tests passed in 6 packages: neosyringe 3, core 559, lsp 45, ui 44, cli 47, unplugin 150. |
| 5 | `pnpm test:e2e` | local | 0 | 24 files, 264 tests passed. 5.89 s. It includes `tests/e2e/t21-integrated.test.ts` (7 tests) and `tests/e2e/t21-closed-bundle.test.ts` (2 tests). That count included the T21 known-issue test (1 test), which the fix later replaced with the test T08-ALL-1 open parent {all} resolves ['auth','log'] in `tests/e2e/t08-child-all-open-parent.test.ts`. |
| 6 | `pnpm test:coverage` | local | 0 | The same 848 tests passed. No per-package threshold failed. All files, statements: core 88.76 %, lsp 97.89 %, ui 100 %, cli 45.7 %, unplugin 92.06 %, neosyringe 40 %. |
| 7 | `pnpm docs:build` | local | 0 | `build complete in 6.17s.` The build rendered the dossier page. |
| 8 | `pnpm test:ci` | local | 0 | 6 files, 34 tests passed. 1.05 s. It includes `tests/ci/t21-dossier.test.ts` (8 tests) and `tests/ci/tarball-proof.test.ts` (8 tests). |
| 9 | `node scripts/ci/consumer-dist.mjs` | local | 0 | Six tarballs from `pnpm pack`, each proven equal to the disk build: `djodjonx-neosyringe-cli-0.4.1.tgz` (2 dist files), `djodjonx-neosyringe-core-3.2.0.tgz` (18), `djodjonx-neosyringe-lsp-0.4.6.tgz` (2), `djodjonx-neosyringe-0.3.0.tgz` (8), `djodjonx-neosyringe-ui-0.2.1.tgz` (4), `djodjonx-neosyringe-plugin-0.6.1.tgz` (10). Installed with typescript 5.9.3, esbuild 0.27.2, rollup 4.55.2. The script printed `npm network: no`: the install came from the local npm cache. The integrated scenario, built by the installed plugin, equals the pinned report (10 slices). The closed bundle has no sentinel and runs the effect once. `done in 5.7s`. |

The rows of Measurements do not come from that T21 tree. They come from the 2026-11-06 session, on base `65f3521` plus the changes of this branch, with the commands listed in the Measurements table. The size script and the compile-cost runs for sizes 10, 100, 1000 and 5000 each exited 0 (5000: all 8 commands). The size script ran again after the build directory became per checkout, and the bundle rows are from that last run.

## Runs after the open-parent fix

These commands were run in the foreground, one at a time, from the repo root, on the working tree of base `720e9f1` plus the open-parent fix. No commit sha is written for the fix. No CI run covers these results.

| # | Command | Status | Exit | Result |
|---|---------|--------|------|--------|
| 1 | `pnpm --filter @djodjonx/neosyringe-core run build` | local | 0 | CJS `Build complete in 1028ms`. ESM `Build complete in 1047ms`. |
| 2 | `pnpm test` | local | 0 | 852 tests passed in 6 packages: neosyringe 3, core 563, lsp 45, ui 44, cli 47, unplugin 150. |
| 3 | `pnpm test:e2e` | local | 0 | 24 files, 268 tests passed. 8.88 s. |
| 4 | `pnpm test:coverage` | local | 0 | The same 852 tests passed. All files, statements: core 88.83 %, lsp 97.89 %, ui 100 %, cli 45.7 %, unplugin 92.06 %, neosyringe 40 %. |
| 5 | `pnpm typecheck` | local | 0 | `tsc --noEmit` printed no diagnostic. |

## Topic 11: bounded concurrent initialization

`initialization: { concurrency: N }` on a builder lets `initialize()` run up to `N` async steps at once. The default is 1 and writes the same `initialize()` as before. The contract is in [Async Factories](/guide/async-factories#starting-async-services-at-the-same-time); the option is `docs/api/configuration.md`, the failure shape is `docs/api/errors.md`.

| Item | Where | Status |
|------|-------|--------|
| The option is read as a positive integer literal; the other shapes are `NEO_CONFIG_UNSUPPORTED` at their position (`packages/core/src/analyzer/parsers/ConfigParser.ts:215`) | `packages/core/tests/analyzer/f11-concurrency-parser.test.ts::P7 3 is accepted: the graph carries it and nothing is reported`, and one test per refused shape in the same file | Local, ran. |
| A partial that declares it is refused (`packages/core/src/analyzer/collectors/ConfigCollector.ts:927`) | `packages/core/tests/analyzer/f11-concurrency-parser.test.ts::P7 a partial that declares initialization is refused at the member, and the builder keeps the default` | Local, ran. |
| `N` absent or 1 writes the same `initialize()` text, and runs in the order of cd61e36 | `packages/core/tests/generator/f11-concurrency-runtime.test.ts`, the `P1` tests: the effect log is a literal captured at cd61e36, the text is compared with `packages/core/tests/generator/f11-frozen.ts`. Topic 19 changed `initialize()` (see Topic 19 below), so that literal is now the text after topic 19; at topic 11 it was the text of cd61e36 | Local, ran on both emitters, full and minimal, open and closed. |
| At most `N` steps at once, a step after every step it reaches (sync factories, `multi`, aliases), one shared dependency once | The `P2`, `P3` and `P4` tests of the same file | Local, ran on the same eight cells. |
| An opaque factory (no `dependencies` list, open mode only) waits for every step of a lower rank; a later step that does not reach it is not held back | The `P12` tests of the same file | Local, ran on the four open cells. |
| An all-opaque graph of 200 steps writes at most two dependencies per job (a linear count), and still runs one step after the other | The `P13` tests of the same file (two per cell) | Local, ran on the four open cells. |
| First failure stops new steps and joins the started ones; one failure is the same error object, two or more are an `AggregateError` with the first as `cause` | The `P5`, `P6` and `P9` tests | Local, ran on the same eight cells. |
| One progress callback: 1000 short steps pass a blocked one at `N = 2`, with no repeated `Promise.race` registration | The `P8` tests, on the full profile of both emitters, open and closed | Local, ran. |
| The emitted scheduler type-checks at lib es2021 without dom or node and holds no unsafe type | `packages/core/tests/generator/f11-floor.test.ts` | Local, ran. |
| `tests/consumer-types/positive/initialization.ts` and `tests/consumer-types/negative/initialization.ts` | `node scripts/ci/consumer-types.mjs tests/consumer-types/positive --pack` and the same with `negative --expect-file expected-diagnostic.txt` | Local, pass (exit 0): the orchestrator gate ran both with and without `--pack`, after `pnpm build`. |
| Emitted-code snapshots | `pnpm test:e2e` | Local, pass (exit 0): the orchestrator gate ran it after `pnpm build`. No snapshot file changed. |
| Scheduling time and heap of 10000 async steps | `node tests/bench/init-cost.mjs` (`NEOSYRINGE_BENCH_INIT_CONCURRENCY=1,4,16` by default) | Pending: measured by the orchestrator at the end of stage F. No number is quoted. |

`pnpm test` in `packages/core` passed 1594 tests in 136 files (1 skipped), `pnpm typecheck` printed no diagnostic and `pnpm lint` reported 0 errors, locally. No CI run covers this work yet.

## Topic 19: cooperative cancellation

`initialize({ signal })` cancels an initialization. The contract is in [Async Factories](/guide/async-factories#cancelling-an-initialization); the types are in [Types](/api/types#initializeoptions-and-abortsignallike); the codes are in [Errors](/api/errors). The default, a call with no options, is unchanged in behavior. Its text changed: `initialize()` is no longer `async`, takes one optional argument and checks the signal between steps (`packages/core/src/generator/LifecycleEmitter.ts:584`), so a join answers the very promise of the first call.

| Item | Where | Status |
|------|-------|--------|
| Aborted before the start: no factory runs, the promise rejects with `signal.reason`, the container ends failed with that cause | The `Q1 aborted before start` tests of `packages/core/tests/generator/f19-cancellation-runtime.test.ts` (their titles are built per cell, so no single title is cited) | Local, ran on both emitters, full and minimal, open and closed, at `N = 1` and `concurrency: 3`. |
| A factory that ignores the signal: the caller stops waiting at once, the late value is disposed once, ready is never published, `resolve` is refused. Sequentially the step after the first never starts once the signal aborted (`started` is `A` alone at `N = 1`) | The `Q2 user abort` test; `Q13` for an abort followed by `destroy()` | Local, ran on the same sixteen cells. |
| `destroy()` aborts the signal of the factory after the terminal state and its own promise are installed, and ends after the work | The `Q2 destroy`, `Q5` and `Q8 destroy` tests | Local, ran on the same sixteen cells. |
| A join with no options or the same signal answers the identical promise; another signal, or a signal after a call without one, is `NEO_INIT_OPTIONS_CONFLICT` with its code and message | The two `Q3` tests | Local, ran on the same sixteen cells. |
| A ready container ignores a later signal, aborted or not; its services are not destroyed | The `Q4` tests | Local, ran on the same sixteen cells. |
| No abort listener is left on a signal after 1000 cycles of ok, failed and aborted initializations | The `Q6` tests | Local, ran on the same sixteen cells. |
| A factory of the initialization gets the signal that aborts with the reason of the caller; a factory called later gets one that never aborts; an expired context refuses `.signal`, declared and opaque factories | The `Q7` tests | Local, ran on the eight cells for declared factories and the four open cells for opaque ones (closed mode refuses an opaque factory). |
| An `initialize()` that nobody can cancel and no factory observes constructs no `AbortController`, with or without a signal from the caller; factories that read the signal share one controller; a join without a signal answers the identical promise, and a join made during the synchronous part of the first call (an `observe()` sink that calls `initialize()` on the first event) waits for the work instead of answering a resolved or stale promise. An observed disposal ends once even when the value it returns throws on a second read of `then`. A container writes one factory context class and one context type for all its factories. A signal read late (after the caller's abort, or after `destroy()` began) is born aborted with the reason of the first abort; read with nothing aborted it is the live signal; a second initialization after a reconfiguration has its own. `signal` is a property of the prototype of the context, not an own one (it is not copied by a spread and not listed by `Object.keys`, which lists `__neoRead`) | The `PA1` to `PA6`, `PB1` to `PB6`, `PC1`, `PD1` and `PE1` tests of `packages/core/tests/generator/f-perf-runtime.test.ts` (see [Stage F: compile-time overhead of the disposal slots](/benchmarks/stage-f-compile-overhead), "Runtime cost") | Local, ran on the eight cells; `PA6` and `PB6` on the four full-profile cells (the minimal profile of the optimized emitter has no `override`). |
| Abort, then a factory error, then a dispose error: the caller has the reason, the work keeps the first failure with `cause` and `cleanupErrors`, no unhandled rejection | The `Q8 abort` test | Local, ran on the same sixteen cells. |
| A scope that is aborted does not touch its parent; a scope of a destroyed parent is refused and keeps no listener | The `Q9` tests | Local, ran on the eight cells. |
| A sync container refuses an aborted signal before its eager lines and is left as it was | The `Q10` tests | Local, ran on the eight cells. |
| The container brings its own controller when the runtime has no `AbortController`. A listener of the factory's signal that throws does not stop the other listeners, the user's abort still rejects the promise you wait on with the reason, `destroy()` does not throw, and the error reaches the host as an unhandled rejection | The `Q11` tests, three per cell | Local, ran on the eight cells. |
| The concurrent scheduler starts no queued job after the abort and joins the running ones | The `Q12` tests | Local, ran on the eight cells at `concurrency: 2`. |
| Untyped code that passes something that is not a signal (`'x'`, `{}`, half a signal, `null`) gets a rejected `TypeError`, never a throw, and nothing starts | The `Q14` tests | Local, ran on the eight cells. |
| While the container is cancelling (abort sent, factory still held): a join with no options or the same signal answers the identical promise and another signal is `NEO_INIT_OPTIONS_CONFLICT`, nothing starts again; a sync factory on the stack that calls `initialize()` gets `NEO_CONTAINER_BUSY`; `createScope()` throws `NEO_CONTAINER_BUSY` and builds no scope; `override`, `overrideMany` (full profile) and `clearOverrides` are `NEO_CONTAINER_BUSY` | The `Q16 join`, `Q16 busy`, `Q16 createScope` and `Q16 override` tests | Local, ran on the sixteen cells at `N = 1` and `concurrency: 3` (the minimal profile of the optimized emitter has no `override` member, the test checks the members a profile has). |
| With `concurrency: 2` and four jobs, `destroy()` while the first two run: the other two never start, destroy ends after the work, the two that ran are closed once | The `Q17` tests | Local, ran on the eight cells. |
| A factory that honours `ctx.signal` and rejects (with the reason, or with an error of its own): the work ends at once without opening any gate, observed has the reason, the container fails with the factory's error, what was built before is closed once; after `destroy()` the factory rejects with the destroyed error and `destroy()` ends. Declared and opaque factories | The `Q18 user abort` and `Q18 destroy` tests | Local, ran on the cells of both modes (`N = 1` and `concurrency: 3`), declared on the eight cells, opaque on the four open ones. |
| The emitted code, async and sync, type-checks at lib es2021 without dom or node and holds no unsafe type | `packages/core/tests/generator/f19-floor.test.ts` | Local, ran on both emitters, six async and two sync sources. |
| A container emits the signal members only when something reads them: none with no async step and no factory, the smallest idle signal (no controller, no stand-in, no initialization check) in a sync class with a factory | The `Q15` tests of `packages/core/tests/generator/f19-floor.test.ts` | Local, ran on both emitters, four sources without a factory and two sync sources with one. |
| `tests/consumer-types/positive/signal.ts`, `tests/consumer-types/positive-nodom/signal.ts` (`lib: ["ES2021"]`), and `tests/consumer-types/negative/signal.ts` with four lines added to `expected-diagnostic.txt` | `tsc` on each fixture with a scratch tsconfig that maps `@djodjonx/neosyringe` to `packages/neosyringe/src/index.ts` | Local, ran: no diagnostic for the two positive ones, and the four new lines of the negative one are in the output. `scripts/ci/consumer-types.mjs ... --pack` needs a build and is not run here. `positive-nodom` has its steps in `.github/workflows/ci.yml` and `.github/workflows/release.yml`. |
| Emitted-code snapshots | `tests/e2e/__snapshots__/snapshots.test.ts.snap` | Changed: the `initialize` of eighteen sync containers (one options argument and the abort check), and the lease of the one container with a factory (the `signal` member and its helpers). No other hunk. |
| Tests that pin emitted text and moved with it | `packages/core/tests/generator/f11-frozen.ts` (the text of `initialize()`), `t14-factory-types.test.ts`, `t23-emission.test.ts`, `t23-rewrites.test.ts` (the type of the factory context), `AsyncFactoryGenerator.test.ts`, `Generator.test.ts`, `packages/core/tests/analyzer/AsyncFactoryIntegration.test.ts` (the signature of `initialize`) | Local, ran. |
| Each test fails when the line it protects is removed | Mutations `Q1` to `Q18`, `W19a` to `W19e` and `W19g` to `W19o`, one per test and one per guard (the order of the two calls in the relay, `__neoReject` before `__neoController.abort`, has no mutation: no test can observe it, because the stand-in no longer throws) | Not run here: the orchestrator runs them. The red run of the tests on the unchanged source is in the report of the round. |

In the current tree, `pnpm test` in `packages/core` passed 2030 tests in 138 files (1 skipped file, 1 skipped test), `pnpm test` in `packages/unplugin` passed 298 tests in 32 files, and `pnpm typecheck` printed no diagnostic, locally. `pnpm lint` ends with 0 errors and 1764 warnings, none in a file of this topic. No CI run covers this work yet.

### Limits

- A signal does not interrupt JavaScript. A factory that ignores it runs to its end, and `destroy()` waits for it.
- With the default sequential initialization (`N` absent or 1), `destroy()` aborts the signal of the factories but does not stop the steps that have not started: they still run and are closed with the rest. That is the behavior `T07-B07` pins, and topic 19 keeps it. With `concurrency` above 1 the scheduler starts no queued job once `destroy()` has begun (`Q17`); no earlier test needed a queued job to start after a destroy.
- A factory listener on the signal given outside an initialization is never called and never released: that signal is shared by every such call, so a factory must not add one per call.
- The `useContainer` parents get no signal: the initialization of a parent is shared, and a scope that is aborted does not abort it.
- An async container needs `AbortController` on `globalThis`, or it uses a stand-in that has the same members. No runtime other than Node 22 was run here.
- There is no default timeout. A deadline is a signal the caller builds.

## Topic 22: optional production observation

The build option `observation` adds `observe(sink, options?)` and `stateSnapshot()` to every container and events around each construct, initialize step and dispose. It is off by default and allowed in production. The contract is in [Observability](/guide/observability); the types are in [Types](/api/types#observation-events-and-the-state-snapshot); the option is in [Configuration](/api/configuration#plugin-options). The option is read by the plugin (`packages/unplugin/src/index.ts:51`) and by the transformer (`packages/unplugin/src/transformer.ts:69`), and reaches the generator in the one place that builds it (`packages/unplugin/src/session.ts:785`).

| Item | Where | Status |
|------|-------|--------|
| Off by default: no member, no helper, no clock read, and the text equals the text of a build that never heard of the option | The `O1` tests of `packages/core/tests/generator/f22-observation-runtime.test.ts` (the same graph is opened without the option and with it `false`, and the texts are compared; `performance.now` is counted while a container is built, initialized, resolved, scoped and destroyed) | Local, ran on both emitters, full and minimal, open and closed. |
| Emitted-code snapshots | `tests/e2e/snapshots.test.ts` | None changed: 18 passed on the committed snapshot file. A build without the option emits the text it emitted before this topic. |
| On, no subscriber: zero clock reads and no meta object; the counters still count | The `O2` tests: the clock is counted through `performance.now` and only the reads made by the emitted code count; the text test checks that the subscriber test (`packages/core/src/generator/observationEmitter.ts:69`) comes before the only meta literal | Local, ran on the eight cells. |
| The default clock is `performance.now`, read only while a sink is subscribed | The `O2 the default clock` test | Local, ran on one cell (optimized, full, open). |
| One start and one end per built singleton, none on a cache hit, a nested dependency nests, the duration is the difference of two reads of the injected clock, an async singleton ends at its settlement (initialize and construct), `N = 3` runs three at once, a class provider, a transient and a class with `dispose()` | The `O3` tests | Local, ran on the eight cells; the class tests on both emitters. |
| Factory throw, async rejection, class constructor throw, dispose error: `end` with outcome `error`, a code only when it matches `NEO_[A-Z0-9_]+`, no message, no stack, no value; an error whose `code` getter throws changes nothing | The `O4` tests | Local, ran on the eight cells; the class test on both emitters. |
| A sink that throws, rejects, or returns a value whose `then` throws: the results and the errors of the application are unchanged, no unhandled rejection, the sinks after it still get every event | The `O5` tests | Local, ran on the eight cells. |
| The key set of a start and of an end is exact, an event is frozen and holds scalars, and a sink that tries to add or replace a property changes nothing for the next sink | The `O6` tests. No test can pass an extra property to the helper through the public API, so the claim that the helper drops one is covered by the exact key set only | Local, ran on the eight cells. |
| The snapshot after success, failure (the rollback is observed), cancellation with a signal, scopes made and destroyed, a sync container, and scopes that take inputs | The `O7` tests | Local, ran on the eight cells; scopes with inputs on sixteen cells (both emitters, both profiles, open and closed, sync and async). |
| Unsubscribe stops the events, twice is harmless, another sink keeps its events, an operation in flight ends without telling the sink, and the container no longer holds the sink (a `WeakRef` is collected; `gc` comes from `v8.setFlagsFromString('--expose-gc')`, so the test is not skipped) | The `O8` tests | Local, ran on the eight cells. |
| A container or a scope lets go of the sinks it took once its `destroy()` is over (the dispose events reach them first), a sink taken through a scope sees the whole tree, a sink taken after the destroy is never called, and the sink is collected | The `O13` tests of `packages/core/tests/generator/f22-observation-runtime.test.ts` | Local, ran on the eight cells. |
| A clock that throws or answers `NaN` at the start gives that sink no event; at the end the `end` is still published, without `durationMs`; `observe()` refuses what is not a function | The `O14` tests | Local, ran on the eight cells. |
| The dispose events of a rollback carry the registration id (a singleton and a multi contribution), a disposer whose result cannot be read ends its operation with an error, and the states `destroying`, `reconfiguring` and `failed` of a sync container | The `O7` rollback test, the `O4` test of the disposer, and the `O7` tests of the sync states | Local, ran: the `reconfiguring` and `failed` tests run on the full profile, since the minimal profile has no `override`. |
| The full profile keeps `on('resolve')`; the minimal profile has `observe` and `stateSnapshot` and neither `on` nor `override` (checked on the optimized emitter, which is the one that gives the minimal profile its surface) | The `O9` tests; `tests/consumer-types/negative/observation.ts` for the types | Local, ran on the eight cells; the fixtures ran against `packages/neosyringe/src/index.ts`. |
| `registrationId` is the token id of the graph, a contribution is `multi:<id>:<index>`, one container id, scopes have ids of their own | The `O10` tests | Local, ran on the eight cells. The tokens manifest is not read by a test: its `runtimeKey` and the graph key come from the same token id service, and no test compares them. |
| The trace adapter forwards the events as they are, skips a channel that says it has no subscriber, forwards when it does not say, works with a Node `diagnostics_channel`, and hides no failure of the channel | `packages/neosyringe/tests/observation.test.ts` (five tests); the four `O11` tests of `f22-observation-runtime.test.ts` put it on a container | Local, ran. |
| `observation: true` reaches the output through the plugin and the transformer, `false` and absent do not, the option is its own, production does not refuse it | `packages/unplugin/tests/observationOption.test.ts` | Local, ran. |
| The output of an observed container type-checks at lib es2021 without dom or node and holds no unsafe type | `packages/core/tests/generator/f22-floor.test.ts` | Local, ran on both emitters, six async and four sync sources. |
| Consumer types: `tests/consumer-types/positive/observation.ts`, `tests/consumer-types/positive-nodom/observation.ts` (`lib: ["ES2021"]`), `tests/consumer-types/negative/observation.ts` with eight lines added to `expected-diagnostic.txt` | `tsc` on each fixture with a scratch tsconfig that maps `@djodjonx/neosyringe` to `packages/neosyringe/src/index.ts` | Local, ran: no diagnostic for the two positive ones, and the eight new lines of the negative one are in the output. `scripts/ci/consumer-types.mjs ... --pack` needs a build and is not run here. No new fixture directory, so no workflow step was added. |
| Harness knobs | `packages/core/tests/helpers/t06-run.ts`, `f-build.ts`, `e17-build.ts`, `e18-build.ts`, `t23-program.ts` (the `observation` option), `tests/bench/runtime-cost.mjs` (the observation axis), `scripts/measure-t17-size.mjs` (a category for the observation members) | Local. |
| Overhead off, on without subscriber, on with subscriber, and size | `NEOSYRINGE_BENCH_OBSERVATION=off,on-no-subscriber,on-subscriber node tests/bench/runtime-cost.mjs` after `pnpm build`: every time metric and `module.raw`, `module.min`, `module.gzip` per mode | Not run here: it needs a build and a quiet machine, and the orchestrator runs it. No figure is quoted. |
| Each test fails when the line it protects is removed | Mutations `O1` to `O13`, `W22a` to `W22m` and `W22n` to `W22z`, `W22aa` to `W22ac`, one per test row and one per guard | Not run here: the orchestrator runs them. The red run of the tests on the unchanged source is in the report of the round. |

### Limits

- The pilot acceptance of the audit sheet (an injected failure identifies the phase and the registration without the debug graph) is not covered here: the adapter is delivered, the pilot is built in its own stage.
- `failures` counts an operation once per phase: a step that fails counts its construct and its initialize.
- An observed container keeps the creator of every class provider: the accessor of the full open profile does not build it in place (`packages/core/src/generator/DirectEmitter.ts:341`).
- A container with a `useContainer` parent reports its own operations only.
- A scope of a destroyed parent stays in `activeScopes` until it is destroyed itself.
- The default clock falls back to `Date.now` where there is no `performance` (`packages/core/src/generator/observationEmitter.ts:142`): durations are then not monotonic, and are clamped at 0.
- The reference emitter writes the full surface for every profile, `on` included, so the minimal profile has its smaller surface on the optimized emitter only.
- A value whose disposer lookup throws (a disposal protocol that is not callable) is part of the failure `destroy()` reports and has no event of its own.

## Integration composition

The proof `integration-composition` runs the features of stage F together, in one graph, and compares every answer with a model that does not import the generator. The proof id is listed with the others in the candidate evidence (`scripts/ci/lib/evidence.mjs:25`, `tests/ci/evidence.test.ts:14`). Its tests are part of the core test job (`.github/workflows/ci.yml:34` runs `pnpm test:coverage`), so a red test makes the job fail.

The graph has scope inputs (`Req`, `Lim`), an alias (`twin`, an alias of `B`), `resolveMany`, two async factories under `initialization: { concurrency: N }` with `N` of 1 and 3, a `useContainer` parent whose `Base` the scope's `A` reads, and disposers on every service. The model is `packages/core/tests/helpers/f-composition-model.ts`: one rule of the topics per branch, a table of five services, and no import from `packages/core/src`. The generated code is run by `packages/core/tests/generator/f-composition-runtime.test.ts`.

| Item | Where | Status |
|------|-------|--------|
| Every answer, error code, set of services built and set of services disposed, and the number of factories running at once in a held initialization, equal the model, including `resolve`, `resolveMany` (empty or not) and `createScope()` called while that initialization is in flight (`NEO_NOT_INITIALIZED`, and `NEO_CONTAINER_BUSY` for the scope); no service is disposed more often than it was built; a dependency is built before its consumer and a consumer is disposed before its dependency; at most `N` factories ran at once | `packages/core/tests/generator/f-composition-runtime.test.ts`, the `I1 composition matrix equals the independent model` tests: two scenarios (inputs, alias, batch, concurrent init, parent, disposal; the parent closed under a live scope) on 16 cells | Local, ran. Green on the source as it stood: guards, proven by the mutation rows below. |
| `overrideMany` while a destroy is requested (full profile): a destroy pending on a slow disposer refuses it as `NEO_CONTAINER_BUSY` and installs no mock; an `overrideMany` in flight refuses `destroy()` as `NEO_CONTAINER_BUSY`, and a later `destroy()` succeeds; after the destroy it is `NEO_CONTAINER_DESTROYED`, nothing reopens and every disposer was called once; while an initialization is cancelling it is `NEO_CONTAINER_BUSY`, `createScope()` too, and no mock is installed | The five `I2` tests of the same file, on the full profile of both emitters, open and closed, at `N = 1` and `concurrency: 3` (8 runs of each). In every window `resolve` and `resolveMany` are called too, and the code is checked: initializing and cancelling `NEO_NOT_INITIALIZED`, a batch in flight `NEO_CONTAINER_BUSY`, a destroy pending on a slow disposer `NEO_CONTAINER_DESTROYED`, a failed initialization `NEO_CONTAINER_FAILED`. After the batch, `initialize()` and `resolve` of the overridden token answer the mock | Local, ran. Green on the source as it stood: guards, proven by the mutation rows below. |
| One state authority: an async container declares `_state` once, the lifecycle states are written on that one field only, and no other field of the class has a name that says state, status, phase, lifecycle or stage. A sync container has no `_state`, and its authority is `_closed`, `_failure` and, where the container can reconfigure, `_reconfiguring` | The `I3` tests of the same file, on both emitters and both profiles, and on an observed container with test overrides, a parent and an alias | Local, ran. The field is declared at `packages/core/src/generator/Generator.ts:918`. |
| The gates that make the three claims above hold: `override`, `overrideMany` and `clearOverrides` refuse while initializing, cancelling, reconfiguring or destroying (`packages/core/src/generator/LifecycleEmitter.ts:1143`), `createScope` refuses while initializing or cancelling (`packages/core/src/generator/LifecycleEmitter.ts:780`), and `destroy()` refuses while reconfiguring (`packages/core/src/generator/LifecycleEmitter.ts:1258`) | The `I2` tests | Local, ran. |
| Each test fails when the line it protects is removed | Mutations `I1` to `I3`, `W-Q1` to `W-Q9` (the `'cancelling'` of the `createScope` gate, the `'cancelling'` of the `overrideMany` gate, the two gates that let an `overrideMany` install after a destroy was requested, the refusal of `destroy()` while reconfiguring, and the five gates of the public resolution: `'cancelling'`, `'initializing'`, `'reconfiguring'`, `'destroying'` and `'failed'` of `_guardPublic`, `packages/core/src/generator/LifecycleEmitter.ts:682` to `:693`; the `'destroying'` gate is the only answer when a destroy is requested during a held initialization, because the interior of `resolve` skips its closed check while an initialization runs, `packages/core/src/generator/ResolveEmitter.ts:71`) | Not run here: the orchestrator runs them. |

Cells that are not admissible, and why:

- The minimal profile has no `overrideMany`: the reference emitter passes it no `manyNames` (`packages/core/src/generator/Generator.ts:629`) and the optimized emitter writes no override method for it (`packages/core/src/generator/DirectEmitter.ts:406`). The reference emitter does write `override` and `clearOverrides` for the minimal profile, which the public type of that profile does not expose (`docs/guide/states-and-ownership.md:19`). The `I2` scenario is about `overrideMany`, so that cell is not admissible for it: `I2` runs on the full profile only, and no step of it calls `override` or `clearOverrides` on a minimal cell. `I1` makes no override call and runs the minimal profile for everything else.
- In a closed container an input cannot be a root: `roots: [c, d, twin, B, E, req]` is refused with `NEO_MISSING_PROVIDER: root 'Req' is not registered.` (the analyzer's message, found by building the cell). The closed cells of `I1` use the services and the alias as roots; `A` and the parent's `Base` are not roots, and `resolve` of them answers `NEO_ROOT_NOT_EXPORTED`, which the model also says.
- In a closed container, `resolve` of the alias is allowed when the alias is a root (the cells list `twin`).

Limits: the model covers the answers a user can observe, not the order of the disposals between independent services (the graph does not fix it; the test checks only the order it does fix). The integration is proven on the generated code of the two emitters, not on a bundle: the `scopes-soak`, `watch-soak` and `workspace-consumer` proofs are separate.

## Compile-time overhead of the disposal slots

The build metric of `full` rose at the commit of the disposal protocols because each disposal slot wrote the whole protocol inline. A first fix put the protocol in one member that every slot called; it cut the generated text and made `destroy()` 1.75 times slower (measured by the orchestrator). The slot now keeps its own call of the disposer and shares only the read of the instance and the handling of a returned promise. The cause, the numbers (the orchestrator's, and the author's of the perf round), and the tests are in [Stage F: compile-time overhead of the disposal slots](/benchmarks/stage-f-compile-overhead). The generated code length of the current form was not re-measured: the first fix's 121341 to 81736 characters (bench case at size 100, flat, `full`, `open`) does not describe it. The context class is written once per container and its type once, which shortens the generated text with every factory (not measured in characters; `PD1` pins the count). The module size of the bench report is 146358 bytes at `cd61e36` and 125583 now (open), the build time 104.7 and 98.3 ms (round 2, run 2, the author's); the transpile time is to be re-measured by the orchestrator on a quiet machine, and no threshold or budget was changed.

The paths of the slot and of its shared members (`_neoTake`, `_neoPend`, `_neoLateEnd`) that the change touched are run by `packages/core/tests/generator/f-disposal-late-slot.test.ts` on both emitters, full and minimal, open and closed, on a sync and an async graph (64 runs): `L1` a dependency of an asynchronously disposable consumer is disposed after the consumer settles, `L2` the rejection of such a late slot is gathered and the slots after it still run, `L3` a guarded slot whose value has no disposer is not a disposal, `L4` a registration nobody resolved is skipped without a failure. The observed `begin` and `end` written at the slot are run by the `F22 construct, initialize and dispose events` tests. Mutations `L1` to `L5` (re-pointed to the current text), one per line of the slot or of the members: the `await` of the late slot, the gathering of its rejection, the test of a missing disposer, the test of a missing instance, the settlement of the observed disposal. Not run here: the orchestrator runs them.
