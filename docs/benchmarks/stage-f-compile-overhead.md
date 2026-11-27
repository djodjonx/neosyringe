# Stage F: compile-time overhead of the disposal slots

This page says why the build metric of `full` rose at commit `4707309` (disposal protocols), what was changed, and what the numbers are. It does not certify a performance: the transpile time after the fix is to be re-measured by the orchestrator on a quiet machine.

## What was measured, and by whom

**Orchestrator measurement, Apple M4 Max, Node 22, 5 interleaved rounds x 15 samples.** Median of 5 process medians, in milliseconds. `codeLen` is the number of characters the generator writes for the container. Size 100, `tests/bench/runtime-cost.mjs` (`NEOSYRINGE_BENCH_SIZES`, `tests/bench/runtime-cost.mjs:28`). The case has 100 classes with a `dispose()` method and one async factory (`tests/bench/runtime-cost.mjs:107`, `tests/bench/runtime-cost.mjs:143`). Load average rose from 2.53 to 10.73 during the campaign because another process started: the `program` column is noisy, the `transpile` and `codeLen` columns are consistent across rounds.

Flat, `full`, `open`:

| sha | program | analyze | generate | transpile | total | codeLen |
|-----|---------|---------|----------|-----------|-------|---------|
| 89951ac | 64.72 | 5.25 | 0.71 | 29.01 | 100.19 | 98401 |
| 6baf3c1 | 65.41 | 5.19 | 0.70 | 29.48 | 102.48 | 100975 |
| 7e207b8 | 70.06 | 5.37 | 0.71 | 30.37 | 107.54 | 101136 |
| 959b890 | 64.95 | 5.57 | 0.72 | 29.34 | 101.02 | 101136 |
| 10663ef | 64.41 | 5.19 | 0.73 | 29.89 | 101.27 | 101136 |
| 4707309 | 66.11 | 5.79 | 0.75 | 37.53 | 109.38 | 115955 |
| d5ee6b5 | 69.65 | 6.19 | 0.75 | 38.10 | 115.33 | 115955 |
| 2facfb8 | 65.95 | 5.81 | 0.77 | 37.58 | 110.07 | 121341 |
| 6f66a0f | 65.58 | 5.56 | 0.76 | 37.63 | 109.30 | 121341 |

Chain, `minimal`, `closed`:

| sha | program | analyze | generate | transpile | total | codeLen |
|-----|---------|---------|----------|-----------|-------|---------|
| 89951ac | 63.81 | 8.14 | 0.75 | 28.51 | 101.89 | 98996 |
| 6baf3c1 | 65.70 | 8.45 | 0.74 | 29.69 | 104.90 | 101570 |
| 7e207b8 | 66.23 | 7.92 | 0.75 | 29.03 | 104.43 | 101570 |
| 959b890 | 65.55 | 8.16 | 0.74 | 29.12 | 104.74 | 101570 |
| 10663ef | 66.28 | 8.48 | 0.77 | 29.46 | 105.31 | 101570 |
| 4707309 | 65.72 | 8.03 | 0.77 | 33.83 | 108.13 | 116389 |
| d5ee6b5 | 64.92 | 7.85 | 0.80 | 34.29 | 108.81 | 116389 |
| 2facfb8 | 65.77 | 8.21 | 0.81 | 35.87 | 110.81 | 121758 |
| 6f66a0f | 66.65 | 8.52 | 0.81 | 34.87 | 111.27 | 121758 |

## Cause

The commit `4707309` is the first row where `transpile` moves (29.34 to 37.53 ms in the flat case, 29.46 to 33.83 ms in the chain case) and where `codeLen` jumps (101136 to 115955). The TypeScript program, the analyzer and the generator times do not move: the cost is in the text the generator writes, which the compiler then has to parse and transpile.

At that commit each disposal slot of `destroy()` wrote the whole protocol itself: the borrowed and seen checks, the choice of the disposer (`_neoDisposer`), the promise handling and, since topic 22, the observed begin and end. A graph of 100 disposable services wrote that block 100 times. The text of one slot is built by `disposeCall` and `disposeSlot` of the commit before the fix (`git show 6f66a0f:packages/core/src/generator/LifecycleEmitter.ts`, the two functions that follow `combinedDisposals`). The same text was also written again for the reconfiguration, which shares the lines of `destroy()`.

## Fix

One private member of the generated class, `_neoDisposeSlot`, holds the protocol once (`packages/core/src/generator/LifecycleEmitter.ts:1003`). Each slot is one call of it (`packages/core/src/generator/LifecycleEmitter.ts:1038`). `destroy()` and the reconfiguration use the same lines (`packages/core/src/generator/LifecycleEmitter.ts:1052`), so they share the member too.

What the member keeps, as it was:

- the instance is read from the cache; a borrowed instance, or one that was already disposed through another key, is left alone, and a live one is marked seen before its disposer runs;
- a slot that may hold a symbol disposer asks `_neoDisposer` which method to call and does nothing when there is none; any other slot calls `dispose()` as is, so a missing method throws the same `TypeError` as before;
- a failure is gathered for the `AggregateError`; a promise a disposer returns is awaited, either together with the others (an early slot) or at once (a late slot, whose dependents wait);
- when the build option `observation` is on, the begin and the end of the disposal are published from the member (`packages/core/src/generator/LifecycleEmitter.ts:985`).

The member is written only when the graph has a disposal slot, in the one function that writes `destroy()` (`packages/core/src/generator/LifecycleEmitter.ts:1238`). A graph with no slot has none (test `C1 a graph with no disposal slot has no member`).

One difference of timing, which no test observes: a late slot whose disposer returns a promise is now awaited through a promise that gathers its rejection, so it takes one more microtask than before. A late slot whose disposer returns nothing is not awaited, as before.

## Numbers after the fix

Measured by the author of the change, from the sources, with a script that rebuilds the case of `tests/bench/runtime-cost.mjs` (the same classes, the same async factory, `new Generator` with the same arguments as `tests/bench/runtime-cost.mjs:359`, and the same text that the bench transpiles, `tests/bench/runtime-cost.mjs:721`). The script is not part of the repository. The generated code length is exact and is the same number as the `codeLen` column at `6f66a0f` (121341), which checks the script against the orchestrator's measurement. The transpile column below is one process, 15 samples, on a loaded machine: it only shows the direction, it is not a campaign.

| case, size 100 | generated chars before (6f66a0f) | generated chars after | transpile, one process, before | transpile, one process, after |
|----------------|----------------------------------|-----------------------|--------------------------------|-------------------------------|
| flat, `full`, `open` | 121341 | 81736 | 35.76 ms | 22.90 ms |
| chain, `minimal`, `closed` | 121758 | 82153 | 31.06 ms | 20.35 ms |

The generated code is also shorter than at `89951ac` (98401 and 98996). The text each slot wrote before `4707309` was not compared with the new one, so this page gives no reason for that. The orchestrator re-measures `program`, `analyze`, `generate` and `transpile` on a quiet machine; no threshold or budget was changed.

## Tests

- `packages/core/tests/generator/f-disposal-size.test.ts`: `C1 100 slots write 100 short calls and one member` (both emitters, a sync and an async graph, observation off and on) pins one declaration of the member, one call per slot and a short call; `C1 a graph with no disposal slot has no member`; `C1-floor` type-checks the member at lib es2021 and checks it holds no unsafe type, with the three shapes of graph (only `dispose()` classes, mixed sync, mixed async), observation off and on, with test overrides.
- The existing disposal and lifecycle tests are unchanged and pass: `npx vitest run` in `packages/core` ran 142 files (1 skipped file), among them `t21-disposal-runtime.test.ts`, `t06-lifecycle-runtime.test.ts`, `t07-initialisation-runtime.test.ts`, `e16-override-many-runtime.test.ts`, `e18-scope-inputs-runtime.test.ts`, `e20-alias-runtime.test.ts`, `f19-cancellation-runtime.test.ts` and `f22-observation-runtime.test.ts`. One of them pins emitted text (`packages/core/tests/generator/t21-disposal-runtime.test.ts:640`, `T21-P13`: a graph of `dispose()` classes keeps `__neoInst.dispose();` and no selector), so the member keeps that direct call when no slot may hold a symbol disposer.
- The emitted-code snapshot of one container changed: `tests/e2e/__snapshots__/snapshots.test.ts.snap`, the test `should match snapshot for property tokens` (its `destroy()` had one disposal slot): the slot line is now a call, and the member follows `_runDestroy`.
