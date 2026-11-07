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

`pnpm migration:historical` (`package.json:14`) ran locally on 2026-11-07 and exited 0. It is opt-in. No unit suite calls it. The CI job `historical-migration` (`.github/workflows/ci.yml:119-135`) checks out, sets up Node 22, runs `pnpm build`, then `pnpm migration:historical`, with `continue-on-error: true` and `timeout-minutes: 20`. It is not in `required.needs` (`.github/workflows/ci.yml:141`, `tests/ci/workflows.test.ts:176`). This page does not cite a CI run of that job. Each build ran in a child process whose cwd was that project (`scripts/ci/historical-migration.mjs:851`). The block `builds read nothing under the repo` printed `under the repo: 0` for every build.

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

The candidate printed `NEO_FACTORY_DEPENDENCIES_REQUIRED` for factory `Report` with the default strict plugin and again with `validation: 'compatible'`. It printed `NEO_DISPOSABLE_TRANSIENT_CAPTURED` for container `Cap`. An override that was not awaited printed `{"during":"NEO_CONTAINER_BUSY","after":"fake","closed":1,"syncInitialize":"function"}`. Production `testOverrides` printed `NEO_TEST_API_DISABLED: testOverrides cannot be enabled when NODE_ENV is production` (`packages/core/src/generator/DebugConfig.ts:35`). Script note, not an observation: the FactoryContext block is the constant string `no code asserted: the guide row does not name one, and this script does not invent one` (`scripts/ci/historical-migration.mjs:666`). `FactoryContext` exposes `resolve` and `resolveAll` only (`packages/neosyringe/src/types.ts:94-97`). Closed mode printed `not run here. Closed mode stays on tests/e2e/t20-migration.test.ts` (`tests/e2e/t20-migration.test.ts:106`).

The token row printed BEFORE producer key `User_547bb74f`. An earlier run quoted `User_2579db41`, which followed the temp directory. This run's producers were both `@acme/tokens` with entry src/tokens.ts (`scripts/ci/historical-migration.mjs:842`). The candidate consumer of the historical package, which depends on `@djodjonx/neosyringe` and ships no manifest, printed `NEO_TOKEN_BOUNDARY_UNSUPPORTED: manifest-absent @acme/tokens User` (`packages/core/src/analyzer/shared/tokensManifest.ts:330-334`). The candidate-built producer and the candidate consumer printed `producer key: User_4c3940c5`, `consumer key: User_4c3940c5`, `resolved: {"value":"same","syncInitialize":"function"}`. The last token block printed `historical key differs from candidate key: yes` and `same key across the rebuild: no`.

## Support matrix

"Exercised" means a test or a command ran it. Nothing else is claimed.

| Item | What ran | Status |
|------|----------|--------|
| Node 20 | CI matrix (`.github/workflows/ci.yml:15`) | Not executed locally. Node 20 passed on the base run `42218196764`, not on the candidate. |
| Node 22 | Local `v22.23.2`. CI matrix (`.github/workflows/ci.yml:15`) and the e2e job (`.github/workflows/ci.yml:67`) | Local. The base run `42218196764` failed on Node 22 with a test timeout, see above. |
| Node 24 | Nothing | Not executed. |
| TypeScript | `5.9.3` (`consumer-dist` output, lockfile). The peer range is `>=5.0.0` (`packages/unplugin/package.json:40`) | Only `5.9.3` is exercised. The lower bound of the range is not tested. |
| esbuild | `0.27.2` (`packages/unplugin/package.json:48`), real bundles in `tests/e2e/t21-closed-bundle.test.ts` and `scripts/ci/consumer-dist.mjs` | Local. |
| Rollup | `4.55.2` (`packages/unplugin/package.json:49`), `tests/e2e/t16-elagage.test.ts::T16-A01 rollup` and `scripts/ci/consumer-dist.mjs` | Local. |
| Vite | Vite `8.3.6` (`packages/unplugin/package.json:53`). Real `vite build`, library mode, format `cjs`, mode `production`, `build.write: false`, on this machine (Node v22.23.2). `tests/e2e/t22-real-bundlers.test.ts::T22 vite open bundle returns names and keeps the sentinel`, `tests/e2e/t22-real-bundlers.test.ts::T22 vite closed bundle drops the sentinel and runs the effect`, `tests/e2e/t22-real-bundlers.test.ts::T22 vite build rejects NEO_MISSING_PROVIDER` | Local. No CI run of this build. |
| webpack | webpack `5.112.2` (`packages/unplugin/package.json:55`). Real `webpack()`, mode `production`, target `node`, `library.type` `commonjs2`, esbuild TypeScript loader (`tests/e2e/helpers/esbuild-ts-loader.cjs`, same call as `tests/e2e/t16-elagage.test.ts:137`), Node v22.23.2. `tests/e2e/t22-real-bundlers.test.ts::T22 webpack open bundle returns names and keeps the sentinel`, `tests/e2e/t22-real-bundlers.test.ts::T22 webpack closed bundle drops the sentinel and runs the effect`, `tests/e2e/t22-real-bundlers.test.ts::T22 webpack compile fails with NEO_MISSING_PROVIDER` | Local. No CI run of this build. The missing-provider failure is the compiler callback error from the throw at `packages/unplugin/src/index.ts:168`. This run received no `stats` object. |
| Rspack | No test loads it. Using unplugin does not certify it. | Not exercised. Not certified. |
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
| Open vs closed bundle | `node scripts/measure-t17-size.mjs`, same run. `tests/e2e/fixtures/t21-closed/app.ts` plus a generated heavy provider (500 methods, synthetic), real plugin, esbuild, production. Both bundles are executed and return the same result. Gzip level 9 and Brotli quality 11 on the minified text. | Raw / minified / gzip / Brotli. Open 59706 / 37646 / 12653 / 9908. Closed 30566 / 15706 / 3241 / 2842. Open minus closed 29140 / 21940 / 9412 / 7066. | Local. Open minus closed is the removed heavy provider plus the emitter change of the closed mode (`packages/core/src/generator/Generator.ts:201-203`), not the sentinel alone, and not what an application would gain. The bundle bytes depend on the absolute build path, so another checkout or CI can print other bytes (`docs/guide/profiles.md`). Initial and deferred chunks of this cjs output are not split. The esbuild ESM split is the next row. |
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
- Strict validation follows `createScope()` to the same container (`packages/core/src/analyzer/collectors/resolutionUsages.ts:147`). The integrated scenario builds with `validation: 'strict'` (`tests/e2e/t21-integrated.test.ts:53`). Closed mode still needs its own roots, so the closed container stays a separate fixture, `tests/e2e/fixtures/t21-closed/app.ts`.
- The plugin keeps a bare import of the module of a pruned provider (`packages/core/src/generator/Generator.ts:192-196`). esbuild still lists that module under `metafile.inputs`. It lists no bytes of it under `metafile.outputs`. The closed bundle test checks the outputs.
- Disposable detection reads a `dispose` call signature. A class token uses the instance type (`packages/core/src/analyzer/parsers/InjectionParser.ts:406`). An interface or property token uses `T` (`packages/core/src/analyzer/parsers/InjectionParser.ts:417`). A transient factory uses the return type when that type has `dispose`, otherwise the token type (`packages/core/src/analyzer/parsers/InjectionParser.ts:377`, `packages/core/src/analyzer/parsers/InjectionParser.ts:386`). `any` and `unknown` are not disposable (`packages/core/src/analyzer/parsers/InjectionParser.ts:438`). A static-only `dispose` stays silent. `ownership: 'borrowed'` on a transient does not lift the refusal (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:79`). `validation: 'compatible'` warns only in the core analyzer (`packages/core/src/analyzer/validators/DisposableTransientCaptureValidator.ts:301`). The plugin and the CLI stay strict (`packages/unplugin/src/session.ts:559`, `packages/cli/src/index.ts:105`).
- The bundlers and platforms marked "Not exercised" in the support matrix are not certified.
- Initial and deferred chunks are distinguished for one esbuild ESM bundle (`node scripts/measure-chunk-split.mjs`, `docs/benchmarks/chunk-split-size.md`). Raw, minified, gzip level 9 and Brotli quality 11 are recorded per chunk. Gzip bytes depend on the Node zlib build. The initial chunk holds the container. The deferred chunk holds one synthetic heavy provider (500 methods) reached by a dynamic import. The static control has no deferred chunk. That meets the size part of the tree-shaking item (10-definition-termine.md, line 30 of the spec folder) for this esbuild case: the four costs are recorded, and initial and deferred chunks are told apart. It does not cover Rollup, any other bundler, or a real provider. `scripts/ci/consumer-dist.mjs` is a CI check, not this measure. The cjs bundles of `scripts/measure-t17-size.mjs` are still single outputs (`scripts/measure-t17-size.mjs:158`).
- Compile cost at size 5000, shape `diamond` (4 commands, 8 rows) is indicative: those commands ran while `load1` went up to 33.52 and were not rerun. The groups of size 10, 100 and 1000 and the four size 5000 `linear` groups started with `load1` between 1.94 and 2.73; the four size 5000 `diamond` groups started between 2.43 and 31.08. The machine was shared. A rerun on a quiet machine is needed before relying on these numbers.
- The migration from historical npm archives was run locally by `pnpm migration:historical` (exit 0, see Migration). The CI job is opt-in and not in `required.needs`. This page does not cite a CI run of that job.
- Coverage thresholds are set per package in `packages/*/vitest.config.ts`. This work did not change a threshold.
- The base CI run failed on Node 22 with one 5000 ms timeout, see Known issues. The candidate must be judged on its own CI run, which this page does not cite.

## Known issues

- The base CI run `42218196764` (base commit `bf23efa`) failed in the job "Test (Node 22)", step "Test with coverage". The test "T06-A05 alias and unknown target" (`packages/unplugin/tests/t06-usages.test.ts:225`) took 5129 ms, over the 5000 ms limit. Source: `gh run view 42218196764 --log-failed`, read on 2026-11-06. This failure comes from an earlier task (T06), not from T21.
- This pull request changes that test file so the test is cheaper: the temporary project sets `lib: ['ES2020']` and `types: []` (`packages/unplugin/tests/t06-usages.test.ts:53-56`), so each plugin instance parses fewer library files. No assertion changed. Local measure of that one test, with coverage on, two runs each: 1003 ms and 976 ms before, 255 ms and 248 ms after. Without coverage, one run: 166 ms before, 83 ms after. These are local numbers on one machine. The fix has not run on CI, so nothing here says the run will pass.
- Defect from an earlier task (T05 and T08). It is fixed. A factory of a child container that listed `{ all: token }` for a multi token of its open parent was refused by the build with the message "Missing injection ... is not registered" (code `NEO_MISSING_PROVIDER`, `packages/core/src/generator/GraphValidator.ts:83`). ADR002 (spec folder, line 7) allows `{ all: token }` as a dependency entry, and ADR002 (line 33) asks the validation to use the effective view: local, parent, and public roots when closed. The closed-parent path already copied the exported multi roots (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:213-214`). The open-parent path copied only `parentGraph.nodes` (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:136`). An `{ all }` entry keeps the plain token id (`packages/core/src/analyzer/parsers/InjectionParser.ts:526`), and the validator checks it against that set (`packages/core/src/generator/GraphValidator.ts:77`, `packages/core/src/generator/GraphValidator.ts:100`). At run time `child.resolveAll` already worked (`packages/core/tests/generator/t08-multi-runtime.test.ts::T08-P12 [A07] child delegates or shadows the parent multi list`). The fix is `fix(core): resolve { all } of an open parent multi token in child factories` (base `720e9f1`). The open-parent path now adds each `parentGraph.multiNodes` id to `graph.parentProvidedTokens` (`packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:152`). `tests/e2e/t08-child-all-open-parent.test.ts::T08-ALL-1 open parent {all} resolves ['auth','log']` builds, and the executed code resolves `['auth', 'log']`.
- CI run `42348348123` (base commit `fd50180`) failed in the job "Test (Node 22)", step "Test with coverage". The test "should pass validation for valid configuration" (`packages/cli/tests/cli.test.ts:27`) hit the 5000 ms limit (`Test timed out in 5000ms`). Source: `gh run view 42348348123 --log-failed`, read on 2026-11-07. On that run the other tests of the same file took 1924 ms to 2759 ms. Each test built a new program with default options, so the default library was parsed again, including `lib.dom.d.ts`. A local count of that program is 7 declaration files and 2070 KB. The same count with `lib: ['ES2020']` and `types: []` is 45 declaration files and 425 KB, and `lib.dom.d.ts` is absent. `packages/core/src/analyzer/Analyzer.ts:305` and `packages/core/src/analyzer/Analyzer.ts:316` skip declaration files, so the graph still comes from the fixture. This change parses each declaration file once on one shared host (`packages/cli/tests/cli.test.ts:28-46`) and passes those options through `convertCompilerOptionsFromJson` (`packages/cli/tests/cli.test.ts:14-20`). No assertion changed. In this tree the same test is `packages/cli/tests/cli.test.ts:54`. Local measure of the file, with coverage on, three runs: duration 6.82 s, 5.76 s and 5.88 s before, and 727 ms, 730 ms and 734 ms after. The slowest test was 742 ms, 488 ms and 496 ms before, and 148 ms, 146 ms and 145 ms after. These are local numbers on one machine. The fix has not run on CI yet.

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
