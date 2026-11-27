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

The first fix (commit `8eb37ad`) put the whole protocol in one private member, `_neoDisposeSlot`, that every slot called with five arguments. It cut the generated text, and it made `destroy()` slower at run time: see "Runtime cost" below. The member is gone. The slot is now short and keeps its own call of the disposer; only what calls no user code is shared (`packages/core/src/generator/LifecycleEmitter.ts:1005`).

- `_neoTake` reads the instance of a key from the cache (`packages/core/src/generator/LifecycleEmitter.ts:1007`). A borrowed instance, one already disposed through another key, and a key that was never built answer `__neoSeen` itself, which no cache holds, so the slot tells "not mine to dispose" from any instance, `null` included. A live instance is marked seen before its disposer runs.
- `_neoPend` hands a promise the disposer returned to `__neoPending` (`packages/core/src/generator/LifecycleEmitter.ts:1018`). It exists only when the graph has an early slot.
- `_neoLateEnd` answers a promise a late slot's disposer returned, with its rejection gathered, for the slot to await at once (`packages/core/src/generator/LifecycleEmitter.ts:1023`). It exists only when the graph has a late slot.
- The slot calls `dispose()` itself, or asks `_neoDisposer` which method to call when it may hold a symbol disposer; when the build option `observation` is on it also writes the begin and the end of the disposal (`packages/core/src/generator/LifecycleEmitter.ts:1041`). A failure of the call is gathered for the `AggregateError`. In the observed form the slot hands the tail what `_neoRest` answers (`packages/core/src/generator/observationEmitter.ts:255`, `packages/core/src/generator/LifecycleEmitter.ts:1046`): nothing for a plain value, the settling promise otherwise. Round 1 gave the tail the value itself, which reads `then` a second time; a getter that throws on that second read made the slot end the operation twice, `ok` then `error` (found by the reviewer; test `PC1`).
- `destroy()` and the reconfiguration use the same lines and the same members, written once, only for a graph that has a disposal slot (`packages/core/src/generator/LifecycleEmitter.ts:1244`). A graph with no slot has none (test `C1 a graph with no disposal slot has no member`).

A slot is about 300 characters (a bound of 320 for a plain one, 480 for an observed one, pinned by `packages/core/tests/generator/f-disposal-size.test.ts`); the inline form of `cd61e36` was 472 for a plain slot (the line of `S9` in the orchestrator's `d5ee6b5-open.ts`, outside the repository).

One difference of timing, which no test observes: a late slot whose disposer returns a promise is awaited through a promise that gathers its rejection, so it takes one more microtask than before. A late slot whose disposer returns nothing is not awaited, as before.

## Numbers after the fix

The numbers of the first fix (`8eb37ad`), measured by the author of that change with a script that is not in the repository: generated characters of the bench case at size 100 went from 121341 to 81736 (flat, `full`, `open`) and from 121758 to 82153 (chain, `minimal`, `closed`), and the transpile time of one process went from 35.76 to 22.90 ms and from 31.06 to 20.35 ms. They do not describe the current form: the slot is longer now (it keeps the call), and the generated length was not re-measured with that script.

What the current form measures, by the author of the perf round: `tests/bench/runtime-cost.mjs`, size 100, flat, `full`, `open` and `closed`, k locked on the base (`cd61e36`), 5 processes x 7 samples, on a machine with a load average of 5 to 6 (the orchestrator re-measures alone).

| flat, `full`, size 100 | `cd61e36` | current, run 1 | current, run 2 |
|------------------------|-----------|----------------|----------------|
| build, open (ms) | 104.7 | 95.5 | 95.8 |
| build, closed (ms) | 104.3 | 102.0 | 99.2 |
| module `raw`, open (bytes) | 146358 | 125508 | 125508 |
| module `raw`, closed (bytes) | 159273 | 138423 | 138423 |
| module `gzip`, open (bytes) | 8944 | 9364 | 9364 |
| module `gzip`, closed (bytes) | 11051 | 11544 | 11544 |

The build time of the orchestrator at `53b4084` (shared member) was 91.6 ms open; the current form (95.5 and 95.8 ms open, the author's runs) keeps about 9 of the 13 ms that the shared member took from `cd61e36` (104.4 to 91.6 ms, the orchestrator's), and no more. The `gzip` size is 5% above `cd61e36`'s. No threshold or budget was changed.

## Runtime cost

The final runtime bench of the stage (orchestrator, base `cd61e36`, candidate `53b4084`, sizes 10 and 100, 5 processes x 7 samples, run alone, load 2 to 3.5) failed the budget at the default concurrency 1: initialize in 40 cases, destroy 40, cold-resolve 20, create 11, createScope 9 (the fail lines are the orchestrator's `fails-s10.txt` and `fails-s100.txt`, outside the repository).

Attribution by the orchestrator (flat, `full`, size 100, 2 interleaved rounds, ns per operation, mean of the 2 medians):

| metric (mode) | `cd61e36` | `d5ee6b5` | `2facfb8` (cancellation) | `6f66a0f` | `53b4084` (shared member) |
|---------------|-----------|-----------|--------------------------|-----------|---------------------------|
| initialize (open) | 245 | 243 | 622 | 617 | 623 |
| cold-resolve (open) | 60.1 | 59.7 | 74.5 | 74.7 | 73.6 |
| destroy (open) | 3772 | 3766 | 3844 | 3803 | 6598 |
| create (closed) | 1615 | 1621 | 1646 | 1630 | 2033 |
| createScope (closed) | 1615 | 1625 | 1644 | 1632 | 2051 |
| initialize (closed) | 315 | 312 | 791 | 762 | 778 |
| cold-resolve (closed) | 175 | 171 | 214 | 207 | 217 |
| destroy (closed) | 3857 | 3848 | 3913 | 3929 | 6668 |

The observation (`d5ee6b5`, `6f66a0f`) is neutral. Four causes:

1. **initialize x2.5.** Every `initialize()` built a native `AbortController`, a promise and two closures, with or without a signal. Now a call without a signal answers the work itself, with no promise and no closure (`packages/core/src/generator/LifecycleEmitter.ts:610`, `packages/core/src/generator/LifecycleEmitter.ts:613`; a join answers the same promise, `packages/core/src/generator/LifecycleEmitter.ts:593`). The promise exists only once the synchronous part of `_runInitialize` has returned, and user code can call `initialize()` inside it (an `observe()` sink on the first event): `_initObserved` is cleared first (`packages/core/src/generator/LifecycleEmitter.ts:611`) and a join that finds it empty answers a promise that follows `_initObserved` one microtask later (`packages/core/src/generator/LifecycleEmitter.ts:593`), so it waits for the work and never answers the stale promise of an earlier initialization (round 1 assigned `_initObserved` only after the call: the join of that window was a resolved promise, found by the reviewer; tests `PA5`, `PA6`). The controller is made by the first read of a signal, not by `initialize()` (`packages/core/src/generator/signalEmitter.ts:129-138`). `_neoAbort` is the one place that aborts, and it records the first reason (`packages/core/src/generator/signalEmitter.ts:140`), so a controller made after the abort of the caller or after `destroy()` began is born aborted with that reason (`destroy()` calls it, `packages/core/src/generator/LifecycleEmitter.ts:1330`). The controller is dropped when the work ends (`packages/core/src/generator/LifecycleEmitter.ts:682`). The factory context asks for its signal when the factory reads it, not when the call opens (`packages/core/src/generator/factoryLeaseEmitter.ts:113-116`, `packages/core/src/generator/FactoryEmitter.ts:460-463`).
2. **The context accessor.** About 120 ns of the initialize cost, and of every factory call, came from `get signal()` in an object literal: a closure and a runtime accessor definition per call. A micro benchmark of the lease alone (a script outside the repository: the same literal with and without the accessor, 2 million leases, Node 22, by the author of the perf round) gave 135.7 ns with it and 17.3 ns without; the same context as an instance of a class that has `signal` as an accessor of the prototype gave 30.6 ns. The context is now such an instance (`packages/core/src/generator/factoryLeaseEmitter.ts:65-80`). Round 2 writes that class once per container, for the declared factories and the opaque ones alike (a helper, `factoryContext`, that both ask for: `packages/core/src/generator/factoryLeaseEmitter.ts:132`, `packages/core/src/generator/FactoryEmitter.ts:476`; round 1 wrote one class per opaque declaration), and types its parameters, the lease and every factory through one alias, `type <Class>FactoryContext` (`packages/core/src/generator/signalEmitter.ts:59`), instead of repeating the literal of about 470 characters five times in a container with one declared factory, and once more for every factory. Types leave no code, so this changes the generated text and the transpile input, not the runtime. The consequence a user can see: `signal` is a property of the prototype of the context, not an own one, so `Object.keys(context)` does not list it (it lists `__neoRead`, the function that checks the expiry and returns only the signal) and `{ ...context }` does not copy it; `context.signal` reads as before (documented in `docs/api/types.md` and `docs/guide/migration.md`, test `PE1`).
3. **cold-resolve x1.24.** The guard of the public members compared the state with seven names before it let a ready container through. A ready container now leaves after one comparison and the detailed refusals moved to `_neoRefuse` (`packages/core/src/generator/LifecycleEmitter.ts:686`, `packages/core/src/generator/LifecycleEmitter.ts:690`). That the size of the guard was the cause is a hypothesis: the numbers below support it (cold-resolve is back to 60 ns open) but no run isolated the guard from the other changes.
4. **destroy x1.75 and closed create x1.25** came with the shared member of `8eb37ad`: a hundred classes went through one `.dispose()` call site, with five arguments per slot. The slot keeps its call now (see "Fix"). Closed `create` moved with the same commit although the emitted class has the same fields; after the change it is back to the base within the noise (below). The cause of that move was not isolated.

What the current form measures, by the author of the perf round (same harness as the table above, k locked on the base, flat, `full`, size 100, 5 processes x 7 samples, load average 5 to 6; ns per operation, median of the 5 process medians):

| metric (mode) | `cd61e36` | current, run 2 | ratio | current, run 3 | ratio |
|---------------|-----------|----------------|-------|----------------|-------|
| initialize (open) | 246 | 232 | 0.94 | 230 | 0.93 |
| cold-resolve (open) | 59 | 60 | 1.01 | 60 | 1.01 |
| destroy (open) | 3807 | 3794 | 1.00 | 3825 | 1.00 |
| create (open) | 150 | 151 | 1.01 | 151 | 1.01 |
| createScope (open) | 145 | 154 | 1.06 | 153 | 1.05 |
| initialize (closed) | 317 | 308 | 0.97 | 308 | 0.97 |
| cold-resolve (closed) | 186 | 183 | 0.98 | 169 | 0.91 |
| destroy (closed) | 3842 | 3952 | 1.03 | 3895 | 1.01 |
| create (closed) | 1616 | 1651 | 1.02 | 1637 | 1.01 |
| createScope (closed) | 1617 | 1620 | 1.00 | 1660 | 1.03 |

The comparison of `scripts/ci/performance-budget.mjs` (its `compareBudget` and `distribution`, imported by a script outside the repository) gives `pass` for every metric of run 3 but closed cold-resolve (`inconclusive`, ratio 0.91). Open `createScope` stays at 1.05 to 1.06 in both runs (about 8 ns). The class has five more fields than at `cd61e36`, all undefined at the start (`packages/core/src/generator/Generator.ts:920`, `packages/core/src/generator/Generator.ts:924`); whether they are the cause was not isolated. It is within the budget and was not reduced. The orchestrator re-measures all cases alone.

Two intermediate runs by the author of the perf round: with the accessor still in the context, initialize was 352 ns open and 427 ns closed (ratios 1.43 and 1.34 of the base); with the accessor removed from the literal (a measurement only, not a state of the code), 213 and 287 ns.

### Round 2 (the reviewer's findings)

By the author of the perf round, same harness and base as above, after round 2, 2 runs; load average 7 to 9 for run 1 and 5.5 to 7 for run 2 (the orchestrator re-measures alone). ns per operation, median of the 5 process medians; `raw` and `gzip` are the bytes of the module.

| metric (mode) | `cd61e36` | round 2, run 1 | ratio | round 2, run 2 | ratio |
|---------------|-----------|----------------|-------|----------------|-------|
| initialize (open) | 246.4 | 236.9 | 0.96 | 235.2 | 0.95 |
| cold-resolve (open) | 59.2 | 62.3 | 1.05 | 61.8 | 1.04 |
| destroy (open) | 3807 | 4139 | 1.09 | 3814 | 1.00 |
| create (open) | 150.2 | 155.0 | 1.03 | 153.0 | 1.02 |
| createScope (open) | 145.4 | 154.6 | 1.06 | 155.0 | 1.07 |
| initialize (closed) | 317.5 | 321.9 | 1.01 | 309.8 | 0.98 |
| cold-resolve (closed) | 185.8 | 191.8 | 1.03 | 172.7 | 0.93 |
| destroy (closed) | 3842 | 4077 | 1.06 | 3963 | 1.03 |
| create (closed) | 1615.5 | 1649.8 | 1.02 | 1609.9 | 1.00 |
| createScope (closed) | 1617.1 | 1646.6 | 1.02 | 1621.4 | 1.00 |
| build, open (ms) | 104.7 | 105.7 | | 98.3 | |
| build, closed (ms) | 104.3 | 100.4 | | 99.9 | |

The module is 125583 bytes `raw` and 9376 `gzip` open, 138498 and 11556 closed (round 1: 125508, 9364, 138423, 11544): the 75 bytes are the join of the window and the cleared field. The destroy of run 1 (1.09 open) did not come back in run 2 (1.00), and the load average was 7 to 9 during run 1; the change of round 2 does not touch the unobserved `destroy()` (it changes the observed slot only). The generated-length effect of the shared context class and alias is not in these numbers (types leave no code).

## Tests

- `packages/core/tests/generator/f-disposal-size.test.ts`: `C1 100 slots write 100 short slots that call dispose() themselves, and one _neoTake` (both emitters, a sync and an async graph, observation off and on) pins one declaration of `_neoTake`, no `_neoDisposeSlot`, one slot per service, a bound on the length of a slot, `dispose()` called at every plain slot and `_neoDisposer` asked at every factory slot; `C1 a graph with no disposal slot has no member`; `C1-floor` type-checks the member at lib es2021 and checks it holds no unsafe type, with the three shapes of graph (only `dispose()` classes, mixed sync, mixed async), observation off and on, with test overrides. The earlier form of these tests pinned a call of `_neoDisposeSlot`; that pin was replaced with the approval of the orchestrator, not weakened.
- `packages/core/tests/generator/f-perf-runtime.test.ts`: `PA1` and `PA2` (no `AbortController` is constructed by an initialization nobody can cancel and no factory observes, with and without a signal), `PA3` (factories that read the signal share one controller), `PA4` (a join without a signal is the identical promise), `PB1` to `PB6` (a signal read late is born aborted with the reason of the first abort, `destroy()` or the caller's; it is the live signal otherwise; a second initialization after a reconfiguration has its own). Both emitters, full and minimal, open and closed; `PB6` runs on the full profile only (the minimal profile of the optimized emitter has no `override`). Round 2 adds `PA5` and `PA6` (an `observe()` sink calls `initialize()` during the synchronous part of the first call, and of a second initialization after a reconfiguration: the join is pending until the work ends, and it is not the stale promise), `PC1` (an observed disposal whose result reads `then` twice, the second time with a throwing getter: one `start` and one `end` event), `PD1` (one context class and one context type literal per container, with declared and opaque factories) and `PE1` (`signal` is not an own property of the context; its own members are the three resolvers and `__neoRead`).
- The tests of `f19-cancellation-runtime.test.ts` (`Q1` to `Q18`) are unchanged and pass. `f11-frozen.ts` holds the frozen text of `initialize()`, `_startInitialize()` and `_runInitialize()`; it moved with this change (the no-signal path, the lazy controller).
- The existing disposal and lifecycle tests are unchanged and pass: `npx vitest run` in `packages/core` ran 144 files (1 skipped file), among them `t21-disposal-runtime.test.ts`, `f-disposal-late-slot.test.ts`, `t06-lifecycle-runtime.test.ts`, `t07-initialisation-runtime.test.ts`, `e16-override-many-runtime.test.ts`, `e18-scope-inputs-runtime.test.ts`, `e20-alias-runtime.test.ts`, `f19-cancellation-runtime.test.ts` and `f22-observation-runtime.test.ts`. One of them pins emitted text (`packages/core/tests/generator/t21-disposal-runtime.test.ts:640`, `T21-P13`: a graph of `dispose()` classes keeps `__neoInst.dispose();` and no selector), so a plain slot keeps that statement.
- The emitted-code snapshot of one container changed: `tests/e2e/__snapshots__/snapshots.test.ts.snap`, the test `should match snapshot for property tokens` (its `destroy()` has one disposal slot and its factory has a lease): the lease no longer takes a signal and builds its context from a class, the slot line is the short form, and the members `_neoTake` and `_neoPend` follow `_runDestroy`.
