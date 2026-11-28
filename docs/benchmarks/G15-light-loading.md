# G15 — light loading of the optional tools

Topic 15 of the global delivery. The plugin no longer loads the HTML renderer unless a Vite dev server serves the devtools.

## What changed

- The UI package has a second public entry, `@djodjonx/neosyringe-ui/serialize` (`packages/ui/package.json:16-20`). It is built next to the root entry (`packages/ui/tsdown.config.ts:4`). It exports `serializeGraph`, `serializeGraphWithErrors` and the six serializable types (`packages/ui/src/serialize.ts:11-19`). It has no HTML, Mermaid or panel code.
- The UI root entry is unchanged and still renders (`packages/ui/src/index.ts:1-5`).
- `packages/unplugin/src/session.ts` reads the light entry (`packages/unplugin/src/session.ts:8-9`). It has no `import()`.
- `packages/unplugin/src/index.ts` no longer imports the devtools module statically. `loadDevtools` is `lazyOnce(() => import('./devtools'))` (`packages/unplugin/src/index.ts:87`). It is awaited only in `configureServer`, after the two early returns (`packages/unplugin/src/index.ts:309-314`). `serving` turns on after the await (`packages/unplugin/src/index.ts:315`), so a failed load leaves the graphs unkept.
- `lazyOnce` shares concurrent calls and forgets a rejected load, so the next call tries again (`packages/unplugin/src/lazy.ts:12-25`). The error stays visible to every waiting caller.
- Limit of the retry: Node caches an ESM module whose evaluation threw, and evaluates a CommonJS file again. Checked on Node v22.23.2 with a throwing `.mjs` and a throwing `.cjs`: the `.mjs` ran once for two `import()` calls, the `.cjs` ran twice for two `require()` calls. The limit is written in the comment of `packages/unplugin/src/lazy.ts:6-10`.
- Source resolution for tests and the typechecker: `tsconfig.json:13` and `packages/unplugin/vitest.config.ts:8`. The unplugin suite needs no fresh UI build.

## Tests

| Claim | Test |
| --- | --- |
| The light entry exposes exactly the two functions, ESM and CJS | `tests/ci/g15-serialize-entry.test.ts::serialize subpath ESM and CJS expose exactly the two functions` |
| The light entry has types, import and require | `tests/ci/g15-serialize-entry.test.ts::package.json declares the serialize subpath with types, import and require` |
| It reaches no renderer in any format, and imports only the analyzer | `tests/ci/g15-serialize-entry.test.ts::serialize entry reaches no html, mermaid or panel code in any format` |
| Importing the plugin with `devtools: false` loads no module that holds the renderer (ESM, CJS) | `tests/ci/g15-cold-import.test.ts::plugin dist loads no html module with devtools off` |
| The devtools chunk is separate, reached only by a dynamic import (ESM, CJS) | `tests/ci/g15-cold-import.test.ts::unplugin dist entry reaches devtools only through a dynamic import` |
| The devtools module is not evaluated with devtools off or in production | `packages/unplugin/tests/g15-devtools-loading.test.ts::devtools module is not evaluated when devtools off` and `::devtools module is not evaluated in production` |
| With devtools on, the middleware is installed and serves the HTML page and `data.json` (the on-path). It does not prove "once": a count of 1 holds with or without the sharing | `packages/unplugin/tests/g15-devtools-loading.test.ts::devtools module is loaded once and serves /__neosyringe/ when on` |
| "Once": concurrent loads share one evaluation | `packages/unplugin/tests/g15-lazy.test.ts::shares concurrent loads` |
| A failed load rejects `configureServer` with its error, installs no middleware and keeps no graph on a later transform; the next call retries and serves | `packages/unplugin/tests/g15-devtools-loading.test.ts::a failed devtools load rejects configureServer with its error, and the next call retries` |
| A rejection is retried, an old rejection does not clear a newer attempt | `packages/unplugin/tests/g15-lazy.test.ts` |
| The root entry keeps its six exports | `packages/ui/tests/g15-root-entry.test.ts` |
| Consumers typecheck the subpath from source and from the packed archive | `tests/ci/g15-serialize-types.test.ts` |
| The CI and release workflows run the two `ui-serialize` consumers (release: from source) | `tests/ci/workflows.test.ts::G15-M2 the UI serialize consumers run from the source and from the packed archive in ci, and from the source before a release` (`.github/workflows/release.yml:77-81`) |
| An unknown `--package` exits 1 (`scripts/ci/consumer-types.mjs:29`); a package folder without types for `./serialize` exits 1 with the manifest and the export named (`scripts/ci/lib/pack-archive.mjs:20`) | `tests/ci/g15-consumer-types-branches.test.ts` |
| The CommonJS dynamic-load regex rejects a static `require` | `tests/ci/g15-cold-import.test.ts::the dynamic reference of $format matches $source: $dynamic` |

The cold-import test loads the plugin in a child process with a `module.register` load hook, which exists from Node 20.6, so it runs on the Node 20 and 22 of the CI matrix (`.github/workflows/ci.yml:15`). The hook sees ESM loads. CommonJS loads come from `require.cache` at the end of the child.

## Measures

### Script

```bash
node scripts/measure-cold-import.mjs [--root <checkout>] [--runs 15] [--json]
```

It measures one built checkout. It refuses a dist older than its sources (exit 2). It does not build. Scenario A is `await import(packages/unplugin/dist/index.mjs)` in a fresh process. Scenario B adds `configureServer` of a plugin made with `devtools: true` on a fake server. One uncounted warm-up process per scenario, then `--runs` processes. A separate untimed run lists the files of `packages/` the import loads and which of them hold `buildStandaloneHtml`. The size table is raw and gzip level 9.

It does not measure an application.

### What was measured in this round

The workspace dist was older than the sources of this round, so the script stopped on the workspace (`node scripts/measure-cold-import.mjs` exited 2: `packages/ui/dist/index.mjs` and `packages/unplugin/dist/index.mjs` older than their `src`). Nothing was built in the workspace.

The figures below come from a build of the candidate sources into a scratch folder with the same `tsdown` and the same configs (`tsdown -d <scratch>` in `packages/ui` and in `packages/unplugin --no-dts`), laid out as a checkout (`packages/{ui,unplugin,core}`), then measured with the script and `--root` on that folder. The `core` dist is a copy of the workspace one. Command: `node scripts/measure-cold-import.mjs --root <scratch root> --runs 15 --json`.

- Node v22.23.2, Darwin 27.2.0, Apple M4 Max x16.
- `uptime` before: load averages 2.64 3.02 4.38. After: 2.51 2.99 4.36 (the script's own `loadavg` agrees).
- The base was not measured here. The orchestrator measures it.

| What | Candidate, scratch build |
| --- | --- |
| A: import, median / min / p90 (ms) | 161.8 / 156.7 / 166.0 |
| B: import, median / min / p90 (ms) | 166.1 / 157.5 / 174.0 |
| B: `configureServer` with devtools on, median (ms) | 0.65 |
| RSS after import, median (MB), A | 115.0 |
| Files of `packages/` loaded by the import | 8 files, 640,263 bytes |
| Loaded file that holds `buildStandaloneHtml` | none |

Published files, candidate, scratch build (raw / gzip 9, bytes):

| File | Raw | Gzip |
| --- | --- | --- |
| `packages/ui/dist/index.mjs` | 23,820 | 7,574 |
| `packages/ui/dist/index.cjs` | 23,994 | 7,603 |
| `packages/ui/dist/serialize.mjs` | 4,058 | 1,393 |
| `packages/ui/dist/serialize.cjs` | 4,204 | 1,411 |
| `packages/unplugin/dist/index.mjs` | 9,368 | 3,328 |
| `packages/unplugin/dist/index.cjs` | 9,886 | 3,337 |
| `packages/unplugin/dist/devtools-*.mjs` | 891 | 463 |
| `packages/unplugin/dist/devtools-*.cjs` | 1,020 | 514 |

In the candidate, `packages/ui/dist/index.mjs` imports `./serialize.mjs` (`import { serializeGraph, serializeGraphWithErrors } from "./serialize.mjs"`), so the root entry carries the serializers once.

### Base against candidate (orchestrator's run)

Run by the orchestrator, alone on the machine: `node scripts/measure-cold-import.mjs --root <checkout of 60cdc30, built> --runs 15 --json`, then the same command on the candidate tree at `2a64e2d` (built). Node v22.23.2, Darwin 27.2.0, Apple M4 Max x16. Load averages (1, 5, 15 min): 2.30 2.50 3.08 before the base, 2.18 2.47 3.06 after the candidate.

| What | Base `60cdc30` | Candidate `2a64e2d` |
| --- | --- | --- |
| A: import, median / min / p90 (ms) | 164.0 / 159.2 / 166.0 | 163.0 / 156.6 / 166.6 |
| B: import, median / min / p90 (ms) | 161.5 / 159.4 / 165.7 | 164.8 / 158.3 / 167.2 |
| B: `configureServer`, median (ms) | 0.17 | 0.60 |
| RSS after import, median (MB), A | 114.2 | 115.1 |
| Files of `packages/` loaded, count / bytes | 8 / 633,561 | 8 / 657,789 |
| Loaded files that hold `buildStandaloneHtml` | `packages/ui/dist/index.mjs`, `packages/unplugin/dist/index.mjs` | none |
| `packages/ui/dist/index.mjs` raw / gzip | 27,749 / 8,697 | 23,820 / 7,574 |
| `packages/ui/dist/serialize.mjs` raw / gzip | absent | 4,058 / 1,393 |
| `packages/unplugin/dist/index.mjs` raw / gzip | 6,256 / 2,334 | 9,368 / 3,330 |
| `packages/unplugin/dist/devtools-*.mjs` raw / gzip | absent | 891 / 463 |

The import time does not move (within the spread of 15 runs). The renderer is no longer on the cold path. The loaded bytes grow by 24,228: the candidate also carries the incremental session of topic 04 and the actionable diagnostics of topic 07 in the core and plugin files it loads, so this column does not isolate topic 15. `configureServer` with devtools on now awaits the lazy chunk (0.60 ms against 0.17 ms).

## Reading

What the candidate numbers show without a base:

- The import loads 8 files and 640,263 bytes, and none of them holds the renderer. The renderer is in `packages/ui/dist/index.mjs` (23,820 raw), which the plugin loads only through the devtools chunk (`packages/unplugin/src/devtools.ts:2`).
- Cold import is about 160 ms on the candidate. The same script ran once on the stale workspace dist, which has no light entry and no devtools chunk. That run only shows that the script works: the build behind it is not tied to a commit, so no figure of it is used here or in the recommendation.
- The plugin imports `typescript` at its top (`packages/unplugin/src/index.ts:2`). The spread of the 15 candidate runs of A is 156.7 ms (min) to 166.0 ms (p90), which is the noise to compare a base against.

## Recommendation

Adopted for the structural reason only. The base against candidate table shows no gain in import time (164.0 against 163.0 ms, within the spread) and no gain in loaded bytes on this tree (the column also carries topics 04 and 07). What the change buys is measured and tested: the cold path of the plugin loads no module that holds the HTML renderer (ESM and CJS tests in the Tests table), the light entry is 4,058 bytes raw against 23,820 for the root entry, and the devtools code sits in its own chunk loaded only when devtools are active. Do not claim a time or size gain for applications from this measure.

Costs of the change: `configureServer` is now asynchronous (Vite awaits it), one more published file group, and a second UI export to keep in step with the root entry.
