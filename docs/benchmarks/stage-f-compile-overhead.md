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

### Round 3 (size 10: closed `create` and `createScope`, import of the `parent` shape)

The orchestrator's final run (k locked on the base, size 10) failed two things: closed `create` and `createScope` at about x1.35 to x1.44 (flat, full, closed: 243 -> 339 ns), and the import of the `parent` shape at x1.10 to x1.13 (574 -> 650 us). Its attribution put both on `2facfb8`. Everything below is by the author of round 3 (a scratch directory outside the repository holds the scripts; the worker is `tests/bench/runtime-worker.mjs` on the module of the case; Node v22.23.2, Apple M4 Max; the machine was shared, load average 1.4 to 5.8 except where said).

**Closed `create` is not the fields of `2facfb8`. The measurements point to a threshold of the collector near a batch of 10000 containers; the collector was not traced.**

- The class of the `2facfb8` form has five more fields than the base (`packages/core/src/generator/Generator.ts:920-924`). Taking them out of the module of the current form changed nothing (339 -> 337 ns). Adding one unused field to the `d5ee6b5` form (the form before `2facfb8`) did the whole move (248 -> 336 ns), and replacing a used field by an unused one did the same: the move follows the bytes of a container, not a member.
- The batch of a `create` keeps `k` containers alive until the batch ends (`tests/bench/runtime-cost.mjs:631-638`). With `k` taken from the base, 10000, the same two forms gave 180 and 180 ns at k=4000, 176 and 172 at 8000, 248 and 337 at 10000, 305 and 310 at 12000. The heap after a collection was 1560 bytes per container for the `d5ee6b5` form and 1600 for the current one (50000 containers, a script outside the repository). Hypothesis of the author, not traced: these numbers fit a threshold of the collector between a batch of 8000 and one of 12000 containers, with the base just under it and a container 40 bytes heavier over it. What was varied is `k` (4000, 8000, 10000, 12000) and the bytes of a container; what was measured is the time per `create` and the heap per container. No `--trace-gc` run, no collector time and no count of promoted objects was taken, so that the collector is the cause is inferred from the shape of the sweep and has not been shown.
- With `k` = 100000 locked on both sides, the current form is at parity with the base: 393.7 against 383.9 ns (flat, full, closed, size 10), 1936 against 1938 at size 100 (table below, column "f7fbab4").

A closed container used to build two sets of exported roots, `_singleRoots` and `_multiRoots`, from the same list, for every instance. They are now built once per class, on the first container (`packages/core/src/generator/Generator.ts:956-1001`), and a container keeps a reference. Removing the two sets from the construction gives the numbers below; the heap per container after the change was not measured (only 1560 and 1600 bytes before it), so that the sets are what made a container heavy is the reading of the author, supported by the time of `create` and not by a heap figure. They are not built when the class is defined: a root is an expression of the user's file, and one that is declared further down or comes from an import cycle may not be bound yet. A first container made with a root that still reads `undefined` does not store them, and the next one builds them again. The guard `_assertRoot` still reads the two fields of the container, so the resolve path is the one it was.

Measured, size 10, `closed`, `k` = 100000 for `create` and `createScope` on both sides (the base is the core dist of `cd61e36`, run by a copy of the bench that loads it; 5 processes x 7 samples; ns per operation, median of the 5 process medians; `import` in ns; `raw` in bytes). "after" is the tree of this round, two runs:

| flat, full, closed | `cd61e36` | `f7fbab4` | after, run 1 | after, run 2 |
|---|---|---|---|---|
| create | 383.9 | 393.7 | 187.1 | 188.9 |
| createScope | 384.2 | 392.3 | 189.2 | 187.2 |
| import | 452459 | 496209 | 491417 | 492750 |
| initialize | 268.5 | 250.6 | 236.7 | 234.4 |
| destroy | 665.0 | 672.8 | 664.8 | 658.2 |
| cold-resolve | 113.9 | 114.9 | 93.1 | 93.1 |
| module raw | 36419 | 39674 | 40200 | 40200 |

| parent, full, closed | `cd61e36` | `f7fbab4` | after, run 1 | after, run 2 |
|---|---|---|---|---|
| create | 783.9 | 804.6 | 634.5 | 618.8 |
| createScope | 298.1 | 282.6 | 190.3 | 195.0 |
| import | 571000 | 654375 | 653542 | 655750 |
| initialize | 703.8 | 693.4 | 593.9 | 585.7 |
| destroy | 572.1 | 589.6 | 515.5 | 517.5 |
| cold-resolve | 136.2 | 131.5 | 99.1 | 96.1 |
| module raw | 58419 | 67578 | 68630 | 68630 |

The two minimal closed cases move the same way (flat: create 344.2 -> 343.4 -> 151.6 / 149.1, parent: 725.6 -> 692.0 -> 266.1 / 265.2). Size 100, flat, full, closed, k = 100000 (3 columns: base, `f7fbab4`, after, one run): create 1937.9, 1935.7, 202.2; createScope 1935.5, 1938.7, 195.6; initialize 312.1, 310.1, 237.6; destroy 3900.0, 3825.4, 3950.0; cold-resolve 162.7, 162.4, 52.4; import 1205625, 1171458, 1162083; module raw 159273, 138498, 139024. Size 100 open, run once with the standard command (k from the base file): create 150.7 against 150.2, createScope 152.5 against 145.4, initialize 232.1 against 246.4, cold-resolve 60.4 against 59.2, destroy 3847.3 against 3807.1, import 1033916 against 1079291.

**The standard protocol cannot measure this change.** `tests/bench/lib/measure.mjs` refuses a locked `k` whose batch lasts less than the minimum sample (1 ms, `tests/bench/lib/measure.mjs:13`; `assertCovers`, `tests/bench/lib/measure.mjs:87-88`, called for a locked `k` at `tests/bench/lib/measure.mjs:215-219`). With `k` = 10000 taken from the base, a closed `create` below 100 ns ends the case with `batch k exceeded`. The reduced command of the brief of this round ran (size 10, flat and parent): flat, full, closed and flat, minimal, closed ended with that error, parent closed ran. Size 100, flat, full, closed ended with it too (the base `k` of that case is 10000 for `create` and `createScope`). The cases chain and diamond were not run; they have the same `k` in the base file. The tables above lock `k` at 100000 for `create` and `createScope` of the closed cases, on the base and on the candidate.

**The import is the text, and this round did not reduce it.** The import of a module is read as the bytes it loads: removing members from the module of the `parent` shape (import only, fresh process, 41 interleaved runs per file, median in us, the unchanged module 637, the base 577) gave 622 without `_startInitialize`, 629 without `__neoController` (the stand-in of the controller), 633 without `_neoSignal`, `_neoAbort`, `_neoCheck`, `__neoIdle` and `__neoIdleSignal`, 625 without `_neoTake`, `_neoPend` and `_neoRefuse`, 611 without `__neoContext` and `__neoLease`. That is about 5 us for each KB of text. Parsing alone (`vm.Script` on the module, 40 runs, median) went from 257 to 284 us between the base and `f7fbab4`, about half of the move. The members of one container grew by: `_startInitialize` 1639 bytes, `__neoController` 1220, `_neoRefuse` 720, `_neoSignal` 526, `__neoContext` 427, `_neoTake` 387, `_neoPend` 226 (module of the flat case at size 10, raw JS), and `_close` shrank by 3115. Two things were tried and did not help: building the context class on its first use instead of when the class is defined (import 593 -> 601 us), and nothing smaller than a few hundred bytes was found in `initialize` and `_startInitialize`. The roots change adds 526 bytes per closed container (the static field, `__neoReadRootSets`, the two reads): the import of the closed `parent` shape is 1.13 to 1.16 of the base in the runs above, 1.15 before it. What would bring it back is removing text of `2facfb8`, not shortening it: the stand-in controller is 1.2 KB per container and about 8 us of the `parent` module, and removing it changes the floor of `docs/release/compatibility.md` (an engine that meets `es2021` and has no `AbortController`). That change was not made.

### Round 4 (size 10: the helpers of a module are written once, a compact stand-in)

Round 3 left one open point to stage G: the import of the `parent` shape at size 10 (x1.12 to x1.15 of `cd61e36`, round 3 and the run of this round on `8f35328`). A module that holds two async containers wrote the controller factory, the lease, the context class, the policy builder and `formatToken` once per class. This round writes them once per module. Everything below is by the author of round 4. The machine was shared (load averages below). **Every number here is indicative: the quiet-machine run of the orchestrator decides.**

**What changed**

- A registry, `ModuleHelpers` (`packages/core/src/generator/moduleHelpers.ts:90`), holds the helpers the containers of one source file call. A Generator that gets it (`provenance.shared`, `packages/core/src/generator/Generator.ts:233`) calls the module's names and claims the ids it needs (`packages/core/src/generator/DirectEmitter.ts:409-410`, `packages/core/src/generator/DirectEmitter.ts:421-422`, `packages/core/src/generator/Generator.ts:633-636`, `packages/core/src/generator/signalEmitter.ts:142`). The block is rendered once (`packages/core/src/generator/moduleHelpers.ts:146`).
- What moved to the module is stateless: the controller factory (each call makes its own listener set, flag and reason), `__neoLease`, the context class, `__neoPolicyOf` and `formatToken`. What holds state stays a member of its class: `__neoIdleSignal` and `__neoIdle` (its listeners are shared by the calls of one class and must not cross classes), the state machine, `_initController`, `_initAborted`, the cache of the policy of a declaration. Nothing of the state machine, of the signal identity or of the error codes moved.
- The stand-in of the controller is shorter, with the same listener semantics (in order, once, a throwing listener does not stop the others and reaches the host as an unhandled rejection): `packages/core/src/generator/signalEmitter.ts:77-101`. Its locals are one letter: the body holds no user text, so none can capture a name.
- The zero-slot `destroy()` (`packages/core/src/generator/LifecycleEmitter.ts:1288-1294`) no longer wraps its body in a `try`. Evidence that the `catch` was unreachable: the shape without `await` is the shape of a graph with no disposal slot, because `awaitClose` is `ordered.length > 0` (`packages/core/src/generator/LifecycleEmitter.ts:980`) and a class with a `dispose(): void` has a slot; the body of a graph with no slot is `this.instances.clear();` (`packages/core/src/generator/LifecycleEmitter.ts:1061`), `this.overrides.clear();` and `this.resolveListeners.clear();` (`packages/core/src/generator/LifecycleEmitter.ts:1079`), and the line that throws an `AggregateError` is written only when there is a slot (`packages/core/src/generator/LifecycleEmitter.ts:1080`). The `release` of the observation sink stays: removing it makes `O13 no slot` red (`P9` below).

**Which form each generation path gets**

| path | form | where |
|---|---|---|
| unplugin session (vite, rollup, webpack, esbuild) | module block, also for a file with one container | `packages/unplugin/src/session.ts:1010` makes the registry; `packages/unplugin/src/session.ts:1044-1049` writes the block as a zero-length edit in front of the first top-level statement that is neither an import nor a prologue directive (`packages/unplugin/src/session.ts:1095`), so a container in a nested scope, or in a hoisted function called before its declaration, finds the block bound (round 5 below) |
| ts-patch transformer | module block (same session) | `packages/unplugin/src/transformer.ts:106` calls `runCompilationSession` |
| a session with no `sourceFile` | helpers in each class | `packages/unplugin/src/session.ts:1010`, no registry |
| `Generator.generate()` without `provenance.shared` (unit tests, a container written to a file of its own) | helpers in each class: the text of `8f35328` except the compact stand-in and the removed `catch` | `packages/core/src/generator/Generator.ts:234` |
| CLI | none: `packages/cli/src` never builds a `Generator`; its only import from the generator is `writeTokensManifest` | `packages/cli/src/tokensManifest.ts:5` |

An edit that starts where the container edit starts (a top-level container) sorts before it: `packages/unplugin/src/session.ts:343`, `packages/unplugin/src/session.ts:363` (without it the block is dropped as overlapped; mutation `W2`).

**The bench writes a module the way the plugin does.** `tests/bench/runtime-cost.mjs:360-361` and `tests/bench/runtime-cost.mjs:730` give the containers of one module one registry and write its block once; a base whose generator has no `ModuleHelpers` (`cd61e36`) keeps the old form. Without this the bench would never see the shared form: it builds each container with its own `new Generator(...)`.

**Measured** (size 10; module raw in bytes: `cd61e36` is the base dist run through the same bench, HEAD is `8f35328` from an earlier run of the bench on the same fixtures, candidate is this tree; import in us, median of the 5 process medians, 5 processes x 7 samples, `k` locked from the file of the orchestrator for size 10, `NEOSYRINGE_BENCH_K_FROM`). Load averages (1, 5, 15 min, `sysctl vm.loadavg`): base run before { 1.67 2.35 2.87 }, after { 3.07 2.60 2.85 }; candidate run before { 2.90 2.58 2.84 }, after { 2.61 2.54 2.77 }. The "HEAD ratio" column is the earlier run of `8f35328` against its own base (load 1.9 to 2.7), not the same hour as the rest.

| case (size 10) | module raw: cd61e36 | HEAD 8f35328 | candidate | import us: cd61e36 | candidate | ratio | HEAD ratio (earlier run) |
|---|---|---|---|---|---|---|---|
| flat/full/open | 35114 | 38369 | 37454 | 436.7 | 481.7 | 1.103 | 1.081 |
| flat/full/closed | 36419 | 40200 | 39285 | 450.3 | 491.4 | 1.091 | 1.090 |
| flat/minimal/open | 32703 | 35941 | 35026 | 425.0 | 477.0 | 1.122 | 1.077 |
| flat/minimal/closed | 33028 | 36792 | 35877 | 435.0 | 482.7 | 1.110 | 1.094 |
| chain/full/open | 35844 | 39099 | 38184 | 441.9 | 494.2 | 1.119 | 1.080 |
| chain/full/closed | 37149 | 40930 | 40015 | 464.0 | 502.6 | 1.083 | 1.081 |
| chain/minimal/open | 33460 | 36698 | 35783 | 442.6 | 483.6 | 1.093 | 1.077 |
| chain/minimal/closed | 33785 | 37549 | 36634 | 437.4 | 495.8 | 1.134 | 1.091 |
| diamond/full/open | 36023 | 39278 | 38363 | 476.4 | 500.8 | 1.051 | 1.082 |
| diamond/full/closed | 37328 | 41109 | 40194 | 459.9 | 515.8 | 1.122 | 1.088 |
| diamond/minimal/open | 33648 | 36886 | 35971 | 432.8 | 484.0 | 1.118 | 1.083 |
| diamond/minimal/closed | 33973 | 37737 | 36822 | 446.4 | 491.5 | 1.101 | 1.100 |
| multi/full/open | 36340 | 39055 | 38140 | 445.5 | 492.0 | 1.104 | 1.051 |
| multi/full/closed | 36284 | 39525 | 38610 | 446.7 | 490.7 | 1.099 | 1.078 |
| multi/minimal/open | 34108 | 36806 | 35891 | 430.1 | 485.5 | 1.129 | 1.087 |
| multi/minimal/closed | 34272 | 37496 | 36581 | 430.7 | 492.8 | 1.144 | 1.077 |
| parent/full/open | 55928 | 65087 | 59807 | 559.2 | 598.1 | 1.070 | 1.131 |
| parent/full/closed | 58419 | 68630 | 63323 | 587.1 | 625.4 | 1.065 | 1.138 |
| parent/minimal/open | 51424 | 60549 | 55269 | 534.5 | 574.2 | 1.074 | 1.117 |
| parent/minimal/closed | 53068 | 63245 | 57938 | 544.2 | 590.0 | 1.084 | 1.146 |

- Module bytes: a module with one container is 915 bytes smaller than at HEAD (the compact stand-in, no `private static` heads, no `catch`) and 1783 to 2866 bytes above `cd61e36` (HEAD: 2698 to 3781). The `parent` shape (two async containers) is 5280 to 5307 bytes smaller than at HEAD and 3845 to 4904 bytes above `cd61e36` (HEAD: 9125 to 10211).
- Import: the four `parent` cases go from x1.117..x1.146 (HEAD) to x1.065..x1.084, and `scripts/ci/performance-budget.mjs` gives `pass` for them. **The 1-container cases are not shown to improve by this bench.** Their ratios in this run, x1.05 to x1.14, are above the earlier run of HEAD (x1.05 to x1.10) although their module is 915 bytes smaller: at 4 to 10 us per KB that is 4 to 9 us, under the noise of the run (the `noise` column of the report is 9 to 73 us on the `import` rows). `node scripts/ci/performance-budget.mjs` on these two reports prints `verdict fail`: 11 `import` rows of 1-container shapes and one `create` row (`parent/minimal/open`, x1.102) fail. The machine was not quiet.
- A same-hour comparison without the bench (an ad hoc harness of the author of round 4, written in a scratch directory and not kept: there is no script or command in the repository to re-run it, so these eight ratios cannot be reproduced from this tree; `tests/bench/runtime-cost.mjs` is the committed tool): one process per run, the module is imported after an empty module, 21 interleaved rounds, median, ratio to `cd61e36` (load { 1.37 2.39 2.91 } before, { 1.83 2.46 2.93 } after): `parent/full/open` 1.037 at HEAD and 1.014 candidate; `parent/full/closed` 1.045 and 1.020; `parent/minimal/open` 1.032 and 1.015; `parent/minimal/closed` 1.041 and 1.019; `flat/full/open` 1.017 and 1.006; `flat/full/closed` 1.019 and 1.018; `flat/minimal/closed` 1.018 and 1.012; `diamond/minimal/closed` 1.028 and 1.018. The candidate is under HEAD on the 8 cases run.
- Not done, by decision: the instance machinery (`_neoRefuse`, `_neoTake`, `_neoPend`, `_neoSignal`) stays a member of each class, and the fallback controller is not removed. The 1-container cases keep their +1.8 to +2.9 KB over `cd61e36`.

**Tests of this round.** `packages/unplugin/tests/g-module-helpers.test.ts` (through the real plugin; 4 cells, full and minimal, open and closed): `P1` one controller factory, one lease, one context class, one policy builder and one `formatToken` in a file with two async containers, and both run; `P2` aborting the initialization of A leaves the signal and the listeners of B alone (with `AbortController` and without it); `P3` the idle signal is per class; `P4` the stand-in calls its listeners once and in order, a throwing listener reaches the host, two controllers are independent, a signal read twice is one object; `P5` a container in a nested scope and a top-level one run, and the block is in front of the first top-level statement that holds one (round 5: the block now sits in front of the first statement that is neither an import nor a directive, `I1` below); `P7` the controller factory is at most 800 bytes (786 measured, 1215 at `8f35328`) and a second container costs at least 3500 bytes less than the first (3658 measured); `W3` the transformed file has no diagnostic inside the block (selected by position, round 5) at `lib.es2021` with unused locals refused, and the block holds no unsafe type. `packages/core/tests/generator/g-shared-helpers.test.ts` runs `P1` and the form with no registry on both emitters. `f19-cancellation-runtime.test.ts` (`Q16 busy-now`, 16 cells, `P8`) and `f22-observation-runtime.test.ts` (`O13 no slot`, 2 cells, `P9`) close the two mutations that survived stage F (`W19k`, `W22q`). Red on `8f35328`, the unchanged source: `P1` (`expected 2 to be 1`, 4 cells), `P5` (`expected -1 to be greater than or equal to 0`), `P7` (`expected 1215 to be less than or equal to 800`, `expected 53768 to be less than or equal to 50476`, 8 cells), `W3` (`expected 0 to be greater than 0`, 4 cells); `P2`, `P3`, `P4`, `P8` and `P9` are guards, proven by mutation.

Contract changes: `tests/e2e/__snapshots__/snapshots.test.ts.snap`, 17 snapshots, each changes by the removal of the `try`/`catch` of the zero-slot `destroy()` and by nothing else (`tests/e2e/snapshots.test.ts:39-40` writes them with `generate()` and no registry). `packages/unplugin/tests/transformer.test.ts` lists `ModuleHelpers` next to `NamePool` in its mock of the generator (plain data the session builds for every file). `packages/core/tests/helpers/e17-build.ts` gets the option `shared`.

**Round 5 (stage G, round 2 of the review).** Four things changed after the review of round 4; each is pinned by a test that was red on the round-4 tree (commands and failing assertions are in the report of the round, not here).

- *The block is bound before any statement runs.* Round 4 wrote it in front of the first top-level statement that holds a container. The block declares one `class`, which is not hoisted. A container in a hoisted function declaration, called by an earlier statement (`export const early = makeA();` above `export function makeA() { ... }`), threw `ReferenceError: Cannot access '__neoSharedContext' before initialization` at the first factory call; the form before stage G worked. The block is now written in front of the first top-level statement that is neither an import declaration nor a prologue directive (`packages/unplugin/src/session.ts:1095-1101`, used at `packages/unplugin/src/session.ts:1047`). The block holds type aliases, functions and one class and no `const`, `let` or `var` (`packages/core/src/generator/moduleHelpers.ts:139-145`, the comment of `render`); `I1` in `packages/unplugin/tests/g-module-helpers.test.ts` runs the shape through the real plugin (full and minimal), checks the order of the statements and the kinds of the block, and that the block does not come between a doc comment and its statement (`getStart(sourceFile, true)`, `packages/unplugin/src/session.ts:1099`). When the container is itself that first statement, its edit and the block start at the same offset (`packages/core/src/analyzer/graphAdapter.ts:69`, `:91`); `applyMappedEdits` sorts the zero-length insertion first (`packages/unplugin/src/session.ts:343-345`, `:363`) and `G1` pins it for `export const`, `const` and `export default`. An opaque factory (no `dependencies` list) cannot be written through the plugin: the session analyses with the strict mode (`packages/unplugin/src/session.ts:934`, `packages/unplugin/src/session.ts:949`), which refuses it (`packages/core/src/analyzer/parsers/InjectionParser.ts:759-766`; the default of `new Analyzer(program)` is `strict`, `packages/core/src/analyzer/Analyzer.ts:46`); its context class is the same module class, and `L4` of `packages/core/tests/generator/g-shared-helpers.test.ts` runs it with a registry on both emitters, but the order in front of a hoisted call is not run for it.
- *The shared lease reads the signal through a reader the call gives it.* `leaseFunction` no longer asserts the type of its host: it took `hostSignal: () => Signal` and the call wrote `() => this._neoSignal()` inside the class. **That arrow function made a closure at every factory call and slowed `initialize` by x1.24 to x1.69; round 6 replaces it** (`this._neoSignal`, no closure). The lease of a class (no registry) is unchanged.
- *Names.* `reservedNamesOf` takes the positions of the containers and also reserves the names declared in the scopes around each of them (`packages/core/src/generator/reservedNames.ts:17-28`), so a local named `__neoSharedLease` in a function that holds a container no longer captures the call (`M3`).
- *Parity of the production form.* `L1` to `L4` and `F1` of `packages/core/tests/generator/g-shared-helpers.test.ts` run, with a registry and on both emitters: the declared and refused tokens with their codes and messages, expiry, the `signal` accessor on the prototype (the `PE1` checks), an opaque context, and the scope-input message through the shared `formatToken` (the `E18` case). They were green on the round-4 tree and are guards, proven by mutation. `packages/core/tests/helpers/e18-build.ts` gets the option `shared`.

**Round 6 (stage G, `initialize` x1.24 to x1.69 after round 4).** The orchestrator's quiet run of `7fb3767` against `60cdc30` failed the budget on `initialize` in all 40 cases (sizes 10 and 100), e.g. `flat/full/open/10` 234 -> 387 ns and `parent/full/open/10` 543 -> 830 ns; the same candidate with the registry switched off (inline form, the orchestrator's A/B run of the same hour) was 231 and 539 ns, so the cost was in the shared form.

*Cause.* The call that opens the lease of a declared factory was `__neoSharedLease(policy, label, this, Class.__neoRead_x, () => this._neoSignal())`. The arrow function is a new closure at every factory call,  and every `initialize()` of the bench makes one factory call per container (the async `ready` factory; two for the `parent` shape). Measured on the committed bench (`tests/bench/runtime-cost.mjs`, here a copy that applies a text transform to the generated module before it is transpiled; `NOSHARED=1` is the registry switched off), `flat/full/open/10` and `parent/full/open/10`, `initialize` median in ns, 5 processes x 7 samples, `k` locked from the `60cdc30` report, one run per row, `uptime` at the run 3 days 7:00 to 7:05, load average 2.2 to 3.3 (the machine was not quiet; the rows are ordered in time):

| variant (only this differs from the shared form) | flat | parent |
|---|---|---|
| inline form (`NOSHARED=1`) | 219.6 | 512.9 |
| shared form of `7fb3767` | 376.2 | 809.4 |
| the argument is `undefined`: no closure | 218.1 | 519.3 |
| a closure that captures nothing (`() => undefined`) | 375.8 | 811.7 |
| the context class is a class expression, not a declaration | 384.4 | 787.0 |
| the lease reads `host._neoSignal()` itself, the call passes nothing | 221.7 | 523.5 |
| `Class.prototype._neoSignal` and `hostSignal.call(host)` | 220.5 | 518.4 |
| one static `__neoSignalOf(host)` member per class | 219.5 | 519.1 |
| **`this._neoSignal` and `hostSignal.call(host)` (kept)** | 217.6 | 508.2 |

What the table isolates: the closure, and nothing else of the shared form, costs 157 ns per factory call (376.2 - 219.6 flat; 296 ns parent, two containers). A closure that reads nothing costs the same (375.8), so it is the allocation at the call, not what the closure does. Neither the class declaration of the context (a class expression changes nothing: 384.4) nor the module-level form of the lease is the cause (a module-level lease with no closure is at the inline figure: 221.7). Why one allocation costs 157 ns is not isolated here: no engine-level measurement was made.

*Fix.* The call hands the lease the method itself, `this._neoSignal`, and the lease calls it on the host: `hostSignal: (this: H) => Signal` and `hostSignal.call(host)` (`packages/core/src/generator/factoryLeaseEmitter.ts:161,164`; the call site is `HelperRefs.leaseSignal`, `packages/core/src/generator/moduleHelpers.ts:126`, written at `packages/core/src/generator/factoryLeaseEmitter.ts:263`). The call allocates nothing, adds no member to a class and is 8 bytes shorter than the closure (`, this._neoSignal` against `, () => this._neoSignal()`). The call site passes `this` as the host and reads the member off `this`, so the method is looked up on the same object and called with the same receiver as the closure did. No helper went back to inline and no state is shared: the lease, the context class, the policy builder, `formatToken` and the controller factory stay once per module.

*Numbers of the fix* (built tree, same harness, `NEOSYRINGE_BENCH_K_FROM` the `60cdc30` report, all 40 `initialize` cases, 5 processes x 7 samples; load average 2.4 to 4.3 and `up 3 days, 7:06` to `7:13` while it ran, so the machine was not quiet and the orchestrator's quiet run decides). `initialize` median against `60cdc30` (ratio over 40 cases: min 0.985, max 1.043; `scripts/ci/performance-budget.mjs`: 40 of 40 `initialize` rows `pass`):

| case | `60cdc30` | `7fb3767` | round 6 | ratio |
|---|---|---|---|---|
| flat/full/open/10 | 234.1 | 386.9 | 235.8 | 1.007 |
| flat/minimal/closed/10 | 229.6 | 374.1 | 233.2 | 1.016 |
| chain/minimal/closed/10 | 227.1 | 378.2 | 236.7 | 1.043 |
| parent/full/open/10 | 542.8 | 829.5 | 546.8 | 1.007 |
| parent/full/closed/10 | 590.8 | 839.8 | 614.5 | 1.040 |
| parent/minimal/open/10 | 558.8 | 694.1 | 550.2 | 0.985 |
| flat/full/open/100 | 233.8 | 390.0 | 232.2 | 0.993 |
| parent/full/closed/100 | 639.2 | 889.2 | 644.4 | 1.008 |

- Import and module bytes keep the round-4 gain: the module of `flat/full/open/10` is 37487 raw bytes (37486 at `7fb3767`), `parent/full/open/10` 59857 (59864); the budget script gives the `import` rows of the four `parent` size-10 cases 0.999, 0.992, 1.008 and 1.014 (`pass` or `inconclusive`).
- The same budget run printed two other `fail` rows: `chain/full/closed/10` `create` (x1.158) and `chain/minimal/open/100` `build` (x1.108). Neither row failed in the run of `7fb3767`, neither measures a path this round touches, and neither came back when re-run next to `60cdc30` (2 runs each, interleaved): `create` 185.9 -> 188.6 and 186.9 -> 193.7 ns, `build` 98.1 -> 100.0 and 99.0 -> 98.7 ms (machine load 2.8 to 3.7). They are noise of a loaded machine.

**Test of this round.** `P10` in `packages/unplugin/tests/g-module-helpers.test.ts` (through the real plugin, 4 cells): the module is run with its lease wrapped by a function that records the arguments of every call and then runs the real lease; two async containers make ten lease calls (the factories `tC` and `tX`, three transient `tT`, per container), and the signal reader of those calls takes at most two values (one per class), not ten. It is red on the round-4 tree (`expected 10 to be less than or equal to 2`). The existing `P2`, `P3` and `L1` (`packages/core/tests/generator/g-shared-helpers.test.ts`) pin that the signal read through the new form is the signal of the initialization and of the idle container. No clock is read by any test.


**Orchestrator's final run (stage G, after round 6).** Alone on the machine, `tests/bench/runtime-cost.mjs` with `NEOSYRINGE_BENCH_SIZES=10,100` in a built checkout of `60cdc30`, then in the candidate tree at `50ff410` with `NEOSYRINGE_BENCH_K_FROM` set to the base report, then `node scripts/ci/performance-budget.mjs`. Node v22.23.2, Apple M4 Max x16, 5 processes x 7 samples. Load averages (1, 5, 15 min): 3.12 5.64 5.10 at the start of the base run, 5.55 5.24 5.01 at its end (the load rose above 4 during the base run), 2.41 3.29 4.09 at the end of the candidate run. Verdict against `60cdc30`: 0 fail, 42 inconclusive rows (ratios 0.882 to 1.149), 318 pass; `initialize` is back at the base (flat/full/open/100 236.7 -> 233.8 ns, parent/full/open/100 561.9 -> 552.3 ns). Against `cd61e36`, size 10, same protocol (load 2.80 3.05 3.83 after the base, 2.14 2.77 3.61 after the candidate): every `import` row that ran passes, x1.040 to x1.093 (parent/full/open 567.1 -> 602.8 us, x1.063; parent/full/closed x1.066; parent/minimal/open x1.045); 7 closed cases (flat, chain and diamond closed, full and minimal, and parent/minimal/closed) stop with `batch k exceeded` on the candidate (the `k` of `cd61e36` is too short for the closed `create` made faster in round 3), so their import is not compared in this run. The run before round 6 (same protocol, load 2.60 to 3.00) had all four `parent` import rows passing against `cd61e36` (x1.049 to x1.083), including parent/minimal/closed (x1.056).

## Tests

- `packages/core/tests/generator/f-disposal-size.test.ts`: `C1 100 slots write 100 short slots that call dispose() themselves, and one _neoTake` (both emitters, a sync and an async graph, observation off and on) pins one declaration of `_neoTake`, no `_neoDisposeSlot`, one slot per service, a bound on the length of a slot, `dispose()` called at every plain slot and `_neoDisposer` asked at every factory slot; `C1 a graph with no disposal slot has no member`; `C1-floor` type-checks the member at lib es2021 and checks it holds no unsafe type, with the three shapes of graph (only `dispose()` classes, mixed sync, mixed async), observation off and on, with test overrides. The earlier form of these tests pinned a call of `_neoDisposeSlot`; that pin was replaced with the approval of the orchestrator, not weakened.
- `packages/core/tests/generator/f-perf-runtime.test.ts`: `PA1` and `PA2` (no `AbortController` is constructed by an initialization nobody can cancel and no factory observes, with and without a signal), `PA3` (factories that read the signal share one controller), `PA4` (a join without a signal is the identical promise), `PB1` to `PB6` (a signal read late is born aborted with the reason of the first abort, `destroy()` or the caller's; it is the live signal otherwise; a second initialization after a reconfiguration has its own). Both emitters, full and minimal, open and closed; `PB6` runs on the full profile only (the minimal profile of the optimized emitter has no `override`). Round 2 adds `PA5` and `PA6` (an `observe()` sink calls `initialize()` during the synchronous part of the first call, and of a second initialization after a reconfiguration: the join is pending until the work ends, and it is not the stale promise), `PC1` (an observed disposal whose result reads `then` twice, the second time with a throwing getter: one `start` and one `end` event), `PD1` (one context class and one context type literal per container, with declared and opaque factories) and `PE1` (`signal` is not an own property of the context; its own members are the three resolvers and `__neoRead`).
- `packages/core/tests/generator/f-perf2-runtime.test.ts`: `RC1` two containers of a closed class hold the very same `_singleRoots` and `_multiRoots`, which list the exported tokens (both emitters, full and minimal); `RC2` making a closed container constructs at most two `Set` (the listeners and the borrowed instances), none for its roots; `RC3` a root that was not bound when the first container was made (the `Late` member of the module's own import), single and then multi (read by `resolveAll`), is answered by the next container and still refused by the first; `RC4` the two fields and the class static are typed `ReadonlySet`. `RC1` and `RC2` were run red on the unchanged source (8 failures), `RC4` too (4 failures); `RC3` is a guard of the lazy build and was green before (mutations `W1` and `W3`).
- The tests of `f19-cancellation-runtime.test.ts` (`Q1` to `Q18`) are unchanged and pass. `f11-frozen.ts` holds the frozen text of `initialize()`, `_startInitialize()` and `_runInitialize()`; it moved with this change (the no-signal path, the lazy controller).
- The existing disposal and lifecycle tests are unchanged and pass: `npx vitest run` in `packages/core` ran 144 files (1 skipped file), among them `t21-disposal-runtime.test.ts`, `f-disposal-late-slot.test.ts`, `t06-lifecycle-runtime.test.ts`, `t07-initialisation-runtime.test.ts`, `e16-override-many-runtime.test.ts`, `e18-scope-inputs-runtime.test.ts`, `e20-alias-runtime.test.ts`, `f19-cancellation-runtime.test.ts` and `f22-observation-runtime.test.ts`. One of them pins emitted text (`packages/core/tests/generator/t21-disposal-runtime.test.ts:640`, `T21-P13`: a graph of `dispose()` classes keeps `__neoInst.dispose();` and no selector), so a plain slot keeps that statement.
- The emitted-code snapshot of one container changed: `tests/e2e/__snapshots__/snapshots.test.ts.snap`, the test `should match snapshot for property tokens` (its `destroy()` has one disposal slot and its factory has a lease): the lease no longer takes a signal and builds its context from a class, the slot line is the short form, and the members `_neoTake` and `_neoPend` follow `_runDestroy`.
