import { getEventListeners } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { MATRIX, label, member, withRun, type Cell, type Run, type Spec } from '../helpers/f-build';

/**
 * F19 (topic 19) cooperative cancellation of `initialize({ signal })`, at runtime, on the two emitters, full and minimal,
 * open and closed, with a sequential initialization (no option) and a concurrent one (`concurrency: 3`). Every factory
 * waits on a gate the test opens (a promise, no clock) and ignores the signal it is given: a non-cooperative factory, the
 * case the contract is about. A test reads what a user can observe: what a promise rejects with, which factories started,
 * how many times a value was disposed, which code a public call throws, how many listeners a signal still holds. No test
 * types a method of the container: it is reached through `Reflect` on `unknown`.
 */

const REASON = new Error('stop initializing');
const OTHER_REASON = new Error('another reason');
const FACTORY_ERROR = new Error('factory failure');
const DISPOSE_ERROR = new Error('dispose failure');
const COOPERATIVE_ERROR = new Error('cooperative factory stopped with its own error');
const LISTENER_ERROR = new Error('an abort listener of the factory threw');

/** `{}` is the sequential initialization, `concurrency: 3` the bounded concurrent one. */
const MODES: ReadonlyArray<{ title: string; options: { concurrency?: number } }> = [
  { title: 'N=1', options: {} },
  { title: 'N=3', options: { concurrency: 3 } },
];

const independent = (labels: readonly string[]): Spec[] => labels.map((name) => ({ name, dispose: true }));

interface Watched {
  done: boolean;
  ok: boolean;
  error: unknown;
}

/** What a promise did so far, read without waiting for it. The rejection is observed here, never left unhandled. */
function watch(promise: unknown): Watched {
  const watched: Watched = { done: false, ok: false, error: undefined };
  if (!(promise instanceof Promise)) throw new Error('not a promise');
  promise.then(
    () => {
      watched.done = true;
      watched.ok = true;
    },
    (error: unknown) => {
      watched.done = true;
      watched.error = error;
    },
  );
  return watched;
}

function codeOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** `owner[name](...args)`; a missing member is a failure of the test, not of the product. */
function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method = member(owner, name);
  if (method === undefined) throw new Error(`missing member ${name}`);
  return method(...args);
}

function objectOf(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return value;
}

/** `signal.aborted` of a value that may be no signal at all (a context of a build that has none). */
function abortedOf(signal: unknown): boolean | undefined {
  if (typeof signal !== 'object' || signal === null) return undefined;
  const aborted: unknown = Reflect.get(signal, 'aborted');
  return typeof aborted === 'boolean' ? aborted : undefined;
}

function reasonOf(signal: unknown): unknown {
  return typeof signal === 'object' && signal !== null ? Reflect.get(signal, 'reason') : undefined;
}

/** Adds `listener` to a value that may be no signal; says whether it could. */
function listen(signal: unknown, listener: () => void): boolean {
  if (typeof signal !== 'object' || signal === null) return false;
  const add: unknown = Reflect.get(signal, 'addEventListener');
  if (typeof add !== 'function') return false;
  Reflect.apply(add, signal, ['abort', listener]);
  return true;
}

function abortedBefore(reason: unknown): AbortController {
  const controller = new AbortController();
  controller.abort(reason);
  return controller;
}

/** Runs `scenario` with an `unhandledRejection` listener that is always removed, then says what it saw. */
async function withoutUnhandled(scenario: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await scenario();
    await tick();
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(seen).toEqual([]);
}

function resolveCode(run: Run, name: string): unknown {
  return codeOf(thrown(() => call(run.box, 'resolve', run.token(name))));
}

describe('F19 an initialization aborted before it starts runs no factory', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q1 aborted before start: no factory runs, rejects with signal.reason, ends failed with that cause (${mode.title}, ${label(cell)})`, async () => {
        await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }, { name: 'C' }], mode.options, async (run) => {
          const controller = abortedBefore(REASON);
          const first = await run.start({ signal: controller.signal }).settled;
          expect(first.error).toBe(REASON);
          expect(run.ctl.started).toEqual([]);
          // The container ended failed, and the failure is the reason: a later call rejects with it, a resolve is refused.
          const again = await run.start().settled;
          expect(again.error).toBe(REASON);
          const refused = thrown(() => call(run.box, 'resolve', run.token('A')));
          expect(codeOf(refused)).toBe('NEO_CONTAINER_FAILED');
          expect(refused instanceof Error ? Reflect.get(refused, 'cause') : undefined).toBe(REASON);
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        });
      });
    }
  }
});

describe('F19 a factory that ignores the signal cannot hold the caller or leak its value', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q2 user abort: observed rejects early with the reason, the late value is disposed once, never ready, resolve refused (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            run.ctl.hold('A', 'B');
            const controller = new AbortController();
            const observed = watch(run.start({ signal: controller.signal }).promise);
            await run.settle();
            expect(run.ctl.started).toContain('A');
            expect(observed.done).toBe(false);
            controller.abort(REASON);
            await run.settle();
            // The caller stops waiting while the factory is still running.
            expect(observed.done).toBe(true);
            expect(observed.error).toBe(REASON);
            expect(run.ctl.built.size).toBe(0);
            // The container is not resolvable and not ready while the work is still running.
            expect(resolveCode(run, 'A')).toBe('NEO_NOT_INITIALIZED');
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            // Sequentially the step after A never starts once the signal has aborted: B is not even called. Concurrently both ran.
            expect(run.ctl.started).toEqual(mode.options.concurrency === undefined ? ['A'] : ['A', 'B']);
            // The late value is owned by the container: it is closed once, and ready is never published.
            expect(run.ctl.built.get('A')).toBe(1);
            for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
            expect(resolveCode(run, 'A')).toBe('NEO_CONTAINER_FAILED');
            const later = await run.start().settled;
            expect(later.ok).toBe(false);
            expect(later.error).toBe(REASON);
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
          });
        });
      });

      it(`Q2 destroy: the signal of the factory aborts, destroy waits for the work, the late value is disposed once (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            run.ctl.hold('A', 'B');
            const initialized = watch(run.start().promise);
            await run.settle();
            const factorySignal = run.ctl.signals.get('A');
            expect(abortedOf(factorySignal)).toBe(false);
            const closing = watch(call(run.box, 'destroy'));
            await run.settle();
            // Terminal state first, then the abort: the factory is asked to stop, and destroy is still waiting for it.
            expect(abortedOf(factorySignal)).toBe(true);
            expect(closing.done).toBe(false);
            expect(resolveCode(run, 'A')).toBe('NEO_CONTAINER_DESTROYED');
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(closing.done).toBe(true);
            expect(closing.ok).toBe(true);
            expect(initialized.done).toBe(true);
            expect(run.ctl.built.get('A')).toBe(1);
            for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
            const later = await run.start().settled;
            expect(codeOf(later.error)).toBe('NEO_CONTAINER_DESTROYED');
          });
        });
      });
    }
  }
});

describe('F19 a destroy that follows an abort', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q13 abort, then destroy while the factory still runs: destroy waits for the work, each late value is disposed once, the state is destroyed (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            run.ctl.hold('A', 'B');
            const controller = new AbortController();
            const observed = watch(run.start({ signal: controller.signal }).promise);
            await run.settle();
            controller.abort(REASON);
            await run.settle();
            expect(observed.error).toBe(REASON);
            // The container is still cancelling: destroy marks it closing, and waits for the work.
            const closing = watch(call(run.box, 'destroy'));
            await run.settle();
            expect(closing.done).toBe(false);
            expect(resolveCode(run, 'A')).toBe('NEO_CONTAINER_DESTROYED');
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(closing.ok).toBe(true);
            // The late values went through the close of destroy, and nothing was disposed twice.
            expect(run.ctl.built.get('A')).toBe(1);
            for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
            expect(codeOf((await run.start().settled).error)).toBe('NEO_CONTAINER_DESTROYED');
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
          });
        });
      });
    }
  }
});

describe('F19 joins of an initialization that is running', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q3 no options or the same signal join the identical promise; another signal is refused (${mode.title}, ${label(cell)})`, async () => {
        await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
          run.ctl.hold('A', 'B');
          const controller = new AbortController();
          const other = new AbortController();
          const first = call(run.box, 'initialize', { signal: controller.signal });
          const withoutOptions = call(run.box, 'initialize');
          const sameSignal = call(run.box, 'initialize', { signal: controller.signal });
          expect(withoutOptions).toBe(first);
          expect(sameSignal).toBe(first);
          const refused = watch(call(run.box, 'initialize', { signal: other.signal }));
          await run.settle();
          expect(refused.done).toBe(true);
          expect(codeOf(refused.error)).toBe('NEO_INIT_OPTIONS_CONFLICT');
          expect(refused.error instanceof Error ? refused.error.message : '').toBe('NEO_INIT_OPTIONS_CONFLICT: [F11] initialize() is running with another signal');
          // The refused call changed nothing: the first operation still runs and ends ready.
          run.ctl.openAll();
          await first;
          expect(run.ctl.built.size).toBe(2);
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
          expect(getEventListeners(other.signal, 'abort')).toHaveLength(0);
        });
      });

      it(`Q3 a first call without a signal refuses a later call that has one (${mode.title}, ${label(cell)})`, async () => {
        await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
          run.ctl.hold('A', 'B');
          const controller = new AbortController();
          const first = call(run.box, 'initialize');
          const refused = watch(call(run.box, 'initialize', { signal: controller.signal }));
          await run.settle();
          expect(refused.done).toBe(true);
          expect(codeOf(refused.error)).toBe('NEO_INIT_OPTIONS_CONFLICT');
          expect(call(run.box, 'initialize')).toBe(first);
          run.ctl.openAll();
          await first;
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        });
      });
    }
  }
});

/** The reason a promise rejects with; a promise that fulfils is a failure of the test. */
async function watchedRejection(promise: unknown): Promise<unknown> {
  if (!(promise instanceof Promise)) throw new Error('not a promise');
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('F19 an option that is not a signal', () => {
  for (const cell of MATRIX) {
    it(`Q14 untyped code that passes a signal that is none is refused with a TypeError and starts nothing; the container stays usable (${label(cell)})`, async () => {
      await withRun(cell, independent(['A', 'B']), {}, async (run) => {
        for (const notASignal of ['x', {}, { addEventListener: () => undefined }, null]) {
          // Every refusal of initialize is a rejection, never a throw: `null` must not read a member of nothing.
          const answer: { watched?: Watched } = {};
          const raised = thrown(() => {
            answer.watched = watch(call(run.box, 'initialize', { signal: notASignal }));
          });
          expect(raised, String(notASignal)).toBeUndefined();
          const refused = answer.watched;
          if (refused === undefined) throw new Error('initialize did not answer');
          await run.settle();
          expect(refused.done).toBe(true);
          expect(refused.error).toBeInstanceOf(TypeError);
          expect(run.ctl.started).toEqual([]);
        }
        // Nothing was armed: a plain initialize runs the factories and the container ends ready.
        expect((await run.start().settled).ok).toBe(true);
        expect(run.ctl.built.size).toBe(2);
        expect(resolveCode(run, 'A')).toBeUndefined();
      });
    });
  }
});

describe('F19 a ready container ignores a signal that comes later', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q4 ready: the signal of the factory stays alive, a late aborted signal resolves, services are not destroyed (${mode.title}, ${label(cell)})`, async () => {
        await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
          const controller = new AbortController();
          expect((await run.start({ signal: controller.signal }).settled).ok).toBe(true);
          const factorySignal = run.ctl.signals.get('A');
          // The user signal is no longer relayed once the operation settled: aborting it later aborts nothing.
          controller.abort(REASON);
          expect(abortedOf(factorySignal)).toBe(false);
          const dead = abortedBefore(OTHER_REASON);
          expect((await run.start({ signal: dead.signal }).settled).ok).toBe(true);
          expect((await run.start({ signal: controller.signal }).settled).ok).toBe(true);
          expect(resolveCode(run, 'A')).toBeUndefined();
          expect(run.ctl.disposed.size).toBe(0);
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
          expect(getEventListeners(dead.signal, 'abort')).toHaveLength(0);
        });
      });
    }
  }
});

describe('F19 destroy during an active factory', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q5 state is terminal before the abort listeners; a listener that calls destroy() gets the same promise; destroy ends after the work (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            run.ctl.hold('A', 'B');
            const initialized = watch(run.start().promise);
            await run.settle();
            const seen: { destroyAgain: unknown; resolveCode: unknown; initializeCode: unknown; calls: number } = {
              destroyAgain: undefined,
              resolveCode: undefined,
              initializeCode: undefined,
              calls: 0,
            };
            const listening = listen(run.ctl.signals.get('A'), () => {
              seen.calls += 1;
              seen.destroyAgain = call(run.box, 'destroy');
              seen.resolveCode = resolveCode(run, 'A');
              void watchedRejection(call(run.box, 'initialize')).then((error) => {
                seen.initializeCode = codeOf(error);
              });
            });
            expect(listening).toBe(true);
            const closing = call(run.box, 'destroy');
            const watched = watch(closing);
            await run.settle();
            expect(seen.calls).toBe(1);
            expect(seen.destroyAgain).toBe(closing);
            expect(seen.resolveCode).toBe('NEO_CONTAINER_DESTROYED');
            expect(seen.initializeCode).toBe('NEO_CONTAINER_DESTROYED');
            // destroy has not resolved: the factory is still running and nothing is closed yet.
            expect(watched.done).toBe(false);
            expect(run.ctl.disposed.size).toBe(0);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(watched.done).toBe(true);
            expect(watched.ok).toBe(true);
            expect(initialized.done).toBe(true);
            for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
          });
        });
      });
    }
  }
});

describe('F19 an initialization leaves no listener on the signal it was given', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q6 1000 cycles of ok, failed and aborted initializations leave no abort listener (${mode.title}, ${label(cell)})`, async () => {
        await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
          const shared = new AbortController();
          // While an initialization runs, its signal is watched: one listener, and only one.
          run.ctl.hold('A');
          const running = watch(call(objectOf(call(run.box, 'createScope')), 'initialize', { signal: shared.signal }));
          await run.settle();
          expect(getEventListeners(shared.signal, 'abort')).toHaveLength(1);
          run.ctl.openAll();
          await run.settle();
          expect(running.ok).toBe(true);
          expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);
          const cycles = 1000;
          for (let index = 0; index < cycles; index += 1) {
            const scope = objectOf(call(run.box, 'createScope'));
            const kind = index % 3;
            if (kind === 0) {
              await call(scope, 'initialize', { signal: shared.signal });
            } else if (kind === 1) {
              run.ctl.failWith('A', FACTORY_ERROR);
              expect(await watchedRejection(call(scope, 'initialize', { signal: shared.signal }))).toBe(FACTORY_ERROR);
              run.ctl.failWith('A', undefined);
            } else {
              const controller = new AbortController();
              run.ctl.hold('A', 'B');
              const pending = watch(call(scope, 'initialize', { signal: controller.signal }));
              await tick();
              controller.abort(REASON);
              run.ctl.openAll();
              await tick();
              await tick();
              expect(pending.error).toBe(REASON);
              expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            }
            expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);
          }
          expect(getEventListeners(shared.signal, 'abort')).toHaveLength(0);
        });
      });
    }
  }
});

/** One async singleton `A` and one sync singleton `T`, written with a declared `dependencies` list or without. */
const CONTEXT_GRAPHS: ReadonlyArray<{ title: string; specs: readonly Spec[]; closed: boolean }> = [
  { title: 'declared factories', specs: [{ name: 'A' }, { name: 'T', kind: 'sync' }], closed: true },
  // The analyzer refuses an opaque registration in a closed container (NEO_CLOSED_REQUIRES_STRICT).
  { title: 'opaque factories', specs: [{ name: 'A', opaque: true }, { name: 'T', kind: 'sync', opaque: true }], closed: false },
];

describe('F19 the signal of a factory context', () => {
  for (const cell of MATRIX) {
    for (const item of CONTEXT_GRAPHS.filter((graph) => graph.closed || cell.mode === 'open')) {
      it(`Q7 a factory of the initialization gets the signal that aborts; a sync factory called later gets one that does not (${item.title}, ${label(cell)})`, async () => {
        await withRun(cell, item.specs, {}, async (run) => {
          run.ctl.hold('A');
          const controller = new AbortController();
          const watched = watch(run.start({ signal: controller.signal }).promise);
          await run.settle();
          const initSignal = run.ctl.signals.get('A');
          expect(abortedOf(initSignal)).toBe(false);
          controller.abort(REASON);
          // The user signal reaches the factory's signal, with the same reason.
          expect(abortedOf(initSignal)).toBe(true);
          expect(reasonOf(initSignal)).toBe(REASON);
          run.ctl.openAll();
          await run.settle();
          await run.settle();
          expect(watched.error).toBe(REASON);
        });
      });

      it(`Q7 outside an initialization a factory gets a signal that is not aborted, and an expired context refuses .signal (${item.title}, ${label(cell)})`, async () => {
        await withRun(cell, item.specs, {}, async (run) => {
          const controller = new AbortController();
          expect((await run.start({ signal: controller.signal }).settled).ok).toBe(true);
          const initSignal = run.ctl.signals.get('A');
          expect(abortedOf(initSignal)).toBe(false);
          call(run.box, 'resolve', run.token('T'));
          const lateSignal = run.ctl.signals.get('T');
          expect(abortedOf(lateSignal)).toBe(false);
          expect(lateSignal).not.toBe(initSignal);
          // Where the runtime has `AbortController`, the signals are real ones, so `fetch(url, { signal })` takes them.
          expect(initSignal).toBeInstanceOf(AbortSignal);
          expect(lateSignal).toBeInstanceOf(AbortSignal);
          controller.abort(REASON);
          expect(abortedOf(lateSignal)).toBe(false);
          // A context used after its factory returned refuses every member, `signal` included.
          const expired = thrown(() => Reflect.get(objectOf(run.ctl.contexts.get('A')), 'signal'));
          expect(codeOf(expired)).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
          const expiredSync = thrown(() => Reflect.get(objectOf(run.ctl.contexts.get('T')), 'signal'));
          expect(codeOf(expiredSync)).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
        });
      });
    }
  }
});

describe('F19 the failures of an aborted initialization', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q8 abort, then a factory error, then a dispose error: observed has the reason, work has the first failure and the cleanup errors, nothing is unhandled (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, [{ name: 'A', dispose: true }, { name: 'B', deps: ['A'] }], mode.options, async (run) => {
            run.ctl.hold('B');
            run.ctl.failWith('B', FACTORY_ERROR);
            run.ctl.failDisposeWith('A', DISPOSE_ERROR);
            const controller = new AbortController();
            const observed = watch(run.start({ signal: controller.signal }).promise);
            await run.settle();
            expect(run.ctl.started).toEqual(['A', 'B']);
            controller.abort(REASON);
            await run.settle();
            // The caller got the reason as soon as the signal aborted, whatever the factory does next.
            expect(observed.done).toBe(true);
            expect(observed.error).toBe(REASON);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            // The work keeps the factory error as the cause, and the cleanup error in `cleanupErrors`: today's wrapper.
            const refused = thrown(() => call(run.box, 'resolve', run.token('A')));
            expect(codeOf(refused)).toBe('NEO_CONTAINER_FAILED');
            const failure = refused instanceof Error ? Reflect.get(refused, 'cause') : undefined;
            expect(failure instanceof Error ? failure.message : undefined).toBe(FACTORY_ERROR.message);
            expect(failure instanceof Error ? Reflect.get(failure, 'cause') : undefined).toBe(FACTORY_ERROR);
            expect(failure instanceof Error ? Reflect.get(failure, 'cleanupErrors') : undefined).toEqual([DISPOSE_ERROR]);
            expect(run.ctl.disposed.get('A')).toBe(1);
            // A later initialize rejects with that same failure, not with the reason.
            const later = await run.start().settled;
            expect(later.error).toBe(failure);
          });
        });
      });
    }
  }
});

describe('F19 the failures of a destroyed initialization', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q8 destroy, then a factory error, then a dispose error: the factory is asked to stop, init keeps the factory error, destroy reports the dispose error, nothing is unhandled (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, [{ name: 'A', dispose: true }, { name: 'B', deps: ['A'] }], mode.options, async (run) => {
            run.ctl.hold('B');
            run.ctl.failWith('B', FACTORY_ERROR);
            run.ctl.failDisposeWith('A', DISPOSE_ERROR);
            const initialized = watch(run.start().promise);
            await run.settle();
            const factorySignal = run.ctl.signals.get('B');
            const closing = watch(call(run.box, 'destroy'));
            await run.settle();
            // The terminal state is installed and the factory that runs has been asked to stop; destroy still waits for it.
            expect(abortedOf(factorySignal)).toBe(true);
            expect(closing.done).toBe(false);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            // The initialization keeps the factory error as it is, the close reports the dispose error of the value it closed.
            expect(initialized.error).toBe(FACTORY_ERROR);
            expect(closing.done).toBe(true);
            expect(closing.error instanceof AggregateError ? closing.error.errors : undefined).toEqual([DISPOSE_ERROR]);
            expect(run.ctl.disposed.get('A')).toBe(1);
          });
        });
      });
    }
  }
});

describe('F19 the concurrent scheduler stops starting jobs once the signal has aborted', () => {
  for (const cell of MATRIX) {
    it(`Q12 N=2: after the abort no queued job starts, the jobs that run are joined and their values closed once (${label(cell)})`, async () => {
      await withoutUnhandled(async () => {
        await withRun(cell, independent(['A', 'B', 'C', 'D']), { concurrency: 2 }, async (run) => {
          run.ctl.hold('A', 'B');
          const controller = new AbortController();
          const observed = watch(run.start({ signal: controller.signal }).promise);
          await run.settle();
          expect(run.ctl.started).toEqual(['A', 'B']);
          controller.abort(REASON);
          await run.settle();
          expect(observed.done).toBe(true);
          expect(observed.error).toBe(REASON);
          run.ctl.openAll();
          await run.settle();
          await run.settle();
          // C and D were queued behind the bound: they never start, and the two that ran are closed once each.
          expect(run.ctl.started).toEqual(['A', 'B']);
          expect([...run.ctl.built.entries()]).toEqual([['A', 1], ['B', 1]]);
          for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
          // The work ended with the reason, so the container is failed and not stuck cancelling.
          expect(resolveCode(run, 'A')).toBe('NEO_CONTAINER_FAILED');
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        });
      });
    });
  }
});

describe('F19 a scope and its parent', () => {
  for (const cell of MATRIX) {
    it(`Q9 a scope whose initialize is aborted does not touch the parent (${label(cell)})`, async () => {
      await withoutUnhandled(async () => {
        await withRun(cell, [{ name: 'C' }], { parent: independent(['P']) }, async (run) => {
          const parent = objectOf(run.parent);
          run.ctl.hold('P');
          const controller = new AbortController();
          const observed = watch(run.start({ signal: controller.signal }).promise);
          await run.settle();
          expect(run.ctl.started).toEqual(['P']);
          controller.abort(REASON);
          await run.settle();
          expect(observed.done).toBe(true);
          expect(observed.error).toBe(REASON);
          // The parent keeps initializing for itself, and ends ready: it was not aborted, failed or destroyed.
          run.ctl.openAll();
          await run.settle();
          await run.settle();
          await call(parent, 'initialize');
          expect(run.ctl.built.get('P')).toBe(1);
          expect(run.ctl.disposed.size).toBe(0);
          // The scope never started its own factory: it stopped once the parent was done.
          expect(run.ctl.started).toEqual(['P']);
          expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        });
      });
    });

    it(`Q9 a scope of a destroyed parent is refused and keeps no listener on its signal (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'C' }], { parent: independent(['P']) }, async (run) => {
        const parent = objectOf(run.parent);
        await call(parent, 'initialize');
        await call(parent, 'destroy');
        const controller = new AbortController();
        const refused = await run.start({ signal: controller.signal }).settled;
        expect(refused.ok).toBe(false);
        expect(codeOf(refused.error)).toBe('NEO_CONTAINER_DESTROYED');
        expect(run.ctl.started).toEqual(['P']);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      });
    });
  }
});

/** The cells of the matrix that are closed carry an `eager` root: a sync container that builds something in `initialize()`. */
const SYNC: readonly Spec[] = [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }];

describe('F19 a sync container refuses an aborted signal before its eager lines', () => {
  const eagerOf = (cell: Cell): { eager?: readonly string[] } => (cell.mode === 'closed' ? { eager: ['A'] } : {});
  for (const cell of MATRIX) {
    it(`Q10 initialize({ signal: aborted }) rejects with the reason and builds nothing, then a plain initialize works (${label(cell)})`, async () => {
      await withRun(cell, SYNC, eagerOf(cell), async (run) => {
        const controller = abortedBefore(REASON);
        const refused = await run.start({ signal: controller.signal }).settled;
        expect(refused.error).toBe(REASON);
        expect(run.ctl.built.get('A')).toBeUndefined();
        expect((await run.start().settled).ok).toBe(true);
        expect(run.ctl.built.get('A')).toBe(cell.mode === 'closed' ? 1 : undefined);
        // A signal that is not aborted changes nothing.
        const live = new AbortController();
        expect((await run.start({ signal: live.signal }).settled).ok).toBe(true);
        expect(getEventListeners(live.signal, 'abort')).toHaveLength(0);
      });
    });
  }
});

describe('F19 a runtime without a global AbortController', () => {
  for (const cell of MATRIX) {
    it(`Q11 the container brings its own controller: destroy aborts the signal of the factory with the destroyed error, listeners run once in order (${label(cell)})`, async () => {
      const native: unknown = Reflect.get(globalThis, 'AbortController');
      Reflect.deleteProperty(globalThis, 'AbortController');
      try {
        await withRun(cell, independent(['A']), {}, async (run) => {
          run.ctl.hold('A');
          const initialized = watch(run.start().promise);
          await run.settle();
          const factorySignal = run.ctl.signals.get('A');
          expect(abortedOf(factorySignal)).toBe(false);
          const calls: number[] = [];
          expect(listen(factorySignal, () => calls.push(1))).toBe(true);
          expect(listen(factorySignal, () => calls.push(2))).toBe(true);
          const closing = watch(call(run.box, 'destroy'));
          await run.settle();
          expect(abortedOf(factorySignal)).toBe(true);
          expect(codeOf(reasonOf(factorySignal))).toBe('NEO_CONTAINER_DESTROYED');
          expect(calls).toEqual([1, 2]);
          run.ctl.openAll();
          await run.settle();
          await run.settle();
          expect(closing.ok).toBe(true);
          expect(initialized.done).toBe(true);
          expect(run.ctl.disposed.get('A')).toBe(1);
        });
      } finally {
        Reflect.set(globalThis, 'AbortController', native);
      }
    });
  }
});

/**
 * Runs `scenario` and returns every unhandled rejection it caused. The listeners the test runner installed are set aside
 * for the duration and put back in `finally`: an error a runtime without `AbortController` reports to its host is the
 * behaviour under test, and the runner would count it as a failure of the run.
 */
async function reportedToHost(scenario: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const saved = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await scenario();
    await tick();
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    for (const listener of saved) process.on('unhandledRejection', listener);
  }
  return seen;
}

describe('F19 a factory listener that throws, on a runtime without a global AbortController', () => {
  for (const cell of MATRIX) {
    it(`Q11 a throwing listener does not stop the others or the user's abort: observed still rejects with the reason, and the error reaches the host (${label(cell)})`, async () => {
      const native: unknown = Reflect.get(globalThis, 'AbortController');
      const user = new AbortController();
      Reflect.deleteProperty(globalThis, 'AbortController');
      try {
        const seen = await reportedToHost(async () => {
          await withRun(cell, independent(['A']), {}, async (run) => {
            run.ctl.hold('A');
            const observed = watch(run.start({ signal: user.signal }).promise);
            await run.settle();
            const factorySignal = run.ctl.signals.get('A');
            const calls: number[] = [];
            expect(listen(factorySignal, () => calls.push(1))).toBe(true);
            expect(listen(factorySignal, () => { throw LISTENER_ERROR; })).toBe(true);
            expect(listen(factorySignal, () => calls.push(2))).toBe(true);
            user.abort(REASON);
            await run.settle();
            expect(calls).toEqual([1, 2]);
            expect(observed.done).toBe(true);
            expect(observed.error).toBe(REASON);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(run.ctl.disposed.get('A')).toBe(1);
          });
        });
        expect(seen).toEqual([LISTENER_ERROR]);
      } finally {
        Reflect.set(globalThis, 'AbortController', native);
      }
    });

    it(`Q11 destroy with a throwing listener: destroy does not throw, the other listeners run, the error reaches the host (${label(cell)})`, async () => {
      const native: unknown = Reflect.get(globalThis, 'AbortController');
      Reflect.deleteProperty(globalThis, 'AbortController');
      try {
        const seen = await reportedToHost(async () => {
          await withRun(cell, independent(['A']), {}, async (run) => {
            run.ctl.hold('A');
            const initialized = watch(run.start().promise);
            await run.settle();
            const factorySignal = run.ctl.signals.get('A');
            const calls: number[] = [];
            expect(listen(factorySignal, () => calls.push(1))).toBe(true);
            expect(listen(factorySignal, () => { throw LISTENER_ERROR; })).toBe(true);
            expect(listen(factorySignal, () => calls.push(2))).toBe(true);
            const answer: { closing?: Watched } = {};
            const raised = thrown(() => {
              answer.closing = watch(call(run.box, 'destroy'));
            });
            expect(raised).toBeUndefined();
            await run.settle();
            expect(calls).toEqual([1, 2]);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(answer.closing?.ok).toBe(true);
            expect(initialized.done).toBe(true);
            expect(run.ctl.disposed.get('A')).toBe(1);
          });
        });
        expect(seen).toEqual([LISTENER_ERROR]);
      } finally {
        Reflect.set(globalThis, 'AbortController', native);
      }
    });
  }
});

/** Starts an initialization whose steps are held, aborts its signal and lets the container reach `cancelling`. */
async function cancelling(run: Run, held: readonly string[]): Promise<{ first: unknown; controller: AbortController }> {
  run.ctl.hold(...held);
  const controller = new AbortController();
  const first = call(run.box, 'initialize', { signal: controller.signal });
  watch(first);
  await run.settle();
  controller.abort(REASON);
  await run.settle();
  return { first, controller };
}

describe('F19 the gates of a container whose initialization is cancelling', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      it(`Q16 join: while cancelling no options or the same signal answer the identical promise, another signal is a conflict, nothing starts again (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            const { first, controller } = await cancelling(run, ['A', 'B']);
            const startedBefore = [...run.ctl.started];
            expect(call(run.box, 'initialize')).toBe(first);
            expect(call(run.box, 'initialize', { signal: controller.signal })).toBe(first);
            const other = new AbortController();
            const refused = watch(call(run.box, 'initialize', { signal: other.signal }));
            await run.settle();
            expect(codeOf(refused.error)).toBe('NEO_INIT_OPTIONS_CONFLICT');
            expect(run.ctl.started).toEqual(startedBefore);
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(getEventListeners(other.signal, 'abort')).toHaveLength(0);
          });
        });
      });

      it(`Q16 busy: while cancelling a sync factory on the stack that calls initialize() is refused as transitioning (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, [{ name: 'A', deps: ['T'] }, { name: 'T', kind: 'sync' }], mode.options, async (run) => {
            const answer: { reentered?: Watched } = {};
            run.ctl.onStart('T', () => {
              answer.reentered = watch(call(run.box, 'initialize'));
            });
            await cancelling(run, ['A']);
            // The factory A reads T once its gate opens: T is a sync factory called while the container is cancelling.
            run.ctl.openAll();
            await run.settle();
            await run.settle();
            expect(run.ctl.started).toContain('T');
            const reentered = answer.reentered;
            if (reentered === undefined) throw new Error('the sync factory did not call initialize');
            expect(reentered.done).toBe(true);
            expect(codeOf(reentered.error)).toBe('NEO_CONTAINER_BUSY');
          });
        });
      });

      it(`Q16 createScope: while cancelling it throws NEO_CONTAINER_BUSY and builds no scope (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), mode.options, async (run) => {
            await cancelling(run, ['A', 'B']);
            const answer: { scope?: unknown } = {};
            const raised = thrown(() => {
              answer.scope = call(run.box, 'createScope');
            });
            expect(codeOf(raised)).toBe('NEO_CONTAINER_BUSY');
            expect(answer.scope).toBeUndefined();
            run.ctl.openAll();
            await run.settle();
            await run.settle();
          });
        });
      });

      it(`Q16 override: while cancelling override, overrideMany and clearOverrides are NEO_CONTAINER_BUSY (${mode.title}, ${label(cell)})`, async () => {
        await withoutUnhandled(async () => {
          await withRun(cell, independent(['A', 'B']), { ...mode.options, testOverrides: true }, async (run) => {
            await cancelling(run, ['A', 'B']);
            const mock = (): unknown => ({ name: 'mock' });
            const calls: ReadonlyArray<readonly [string, readonly unknown[]]> = [
              ['override', [run.token('A'), mock]],
              ['overrideMany', [[[run.token('A'), mock]]]],
              ['clearOverrides', []],
            ];
            // The members a profile has: the full one has the three, a minimal container of the optimized emitter has none.
            const present = calls.filter(([name]) => member(run.box, name) !== undefined);
            if (cell.profile === 'full') expect(present.map(([name]) => name)).toEqual(['override', 'overrideMany', 'clearOverrides']);
            for (const [name, args] of present) {
              expect(codeOf(await watchedRejection(call(run.box, name, ...args))), name).toBe('NEO_CONTAINER_BUSY');
            }
            run.ctl.openAll();
            await run.settle();
            await run.settle();
          });
        });
      });
    }
  }
});

describe('F19 the concurrent scheduler stops starting jobs once the container is destroying', () => {
  for (const cell of MATRIX) {
    it(`Q17 N=2: destroy while A and B run, C and D never start, destroy ends after the work and closes A and B once (${label(cell)})`, async () => {
      await withoutUnhandled(async () => {
        await withRun(cell, independent(['A', 'B', 'C', 'D']), { concurrency: 2 }, async (run) => {
          run.ctl.hold('A', 'B');
          const initialized = watch(run.start().promise);
          await run.settle();
          expect(run.ctl.started).toEqual(['A', 'B']);
          const closing = watch(call(run.box, 'destroy'));
          await run.settle();
          expect(closing.done).toBe(false);
          run.ctl.openAll();
          await run.settle();
          await run.settle();
          expect(closing.ok).toBe(true);
          expect(initialized.done).toBe(true);
          // C and D were queued behind the bound when destroy began: they never start.
          expect(run.ctl.started).toEqual(['A', 'B']);
          expect([...run.ctl.built.entries()]).toEqual([['A', 1], ['B', 1]]);
          for (const [name, count] of run.ctl.built) expect(run.ctl.disposed.get(name), name).toBe(count);
        });
      });
    });
  }
});

/** One value that is closed with the container, and one factory that honours the signal it is given. */
function cooperativeSpecs(opaque: boolean): Spec[] {
  return [{ name: 'A', dispose: true, opaque }, { name: 'B', cooperative: true, opaque }];
}

describe('F19 a factory that honours the signal of its context', () => {
  for (const cell of MATRIX) {
    for (const mode of MODES) {
      for (const item of [{ title: 'declared factories', opaque: false }, { title: 'opaque factories', opaque: true }].filter((graph) => !graph.opaque || cell.mode === 'open')) {
        for (const own of [false, true]) {
          it(`Q18 user abort: the work rejects by itself with ${own ? 'the error of the factory' : 'the reason'}, observed has the reason, the value built before is closed once (${item.title}, ${mode.title}, ${label(cell)})`, async () => {
            await withoutUnhandled(async () => {
              await withRun(cell, cooperativeSpecs(item.opaque), mode.options, async (run) => {
                if (own) run.ctl.cooperateWith('B', COOPERATIVE_ERROR);
                run.ctl.hold('B');
                const controller = new AbortController();
                const observed = watch(run.start({ signal: controller.signal }).promise);
                await run.settle();
                await run.settle();
                expect(run.ctl.started).toContain('B');
                controller.abort(REASON);
                await run.settle();
                await run.settle();
                // No gate was opened: the factory stopped on its own, so the work ended and the container is failed.
                expect(observed.error).toBe(REASON);
                const refused = thrown(() => call(run.box, 'resolve', run.token('A')));
                expect(codeOf(refused)).toBe('NEO_CONTAINER_FAILED');
                const failure = own ? COOPERATIVE_ERROR : REASON;
                expect(refused instanceof Error ? Reflect.get(refused, 'cause') : undefined).toBe(failure);
                expect(run.ctl.built.get('A')).toBe(1);
                expect(run.ctl.built.get('B')).toBeUndefined();
                expect(run.ctl.disposed.get('A')).toBe(1);
                expect((await run.start().settled).error).toBe(failure);
                expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
              });
            });
          });
        }

        it(`Q18 destroy: the factory stops on the destroyed error, destroy ends without opening any gate, the value built before is closed once (${item.title}, ${mode.title}, ${label(cell)})`, async () => {
          await withoutUnhandled(async () => {
            await withRun(cell, cooperativeSpecs(item.opaque), mode.options, async (run) => {
              run.ctl.hold('B');
              const initialized = watch(run.start().promise);
              await run.settle();
              await run.settle();
              expect(run.ctl.started).toContain('B');
              const closing = watch(call(run.box, 'destroy'));
              await run.settle();
              await run.settle();
              expect(closing.done).toBe(true);
              expect(closing.ok).toBe(true);
              expect(initialized.done).toBe(true);
              expect(codeOf(initialized.error)).toBe('NEO_CONTAINER_DESTROYED');
              expect(run.ctl.built.get('A')).toBe(1);
              expect(run.ctl.built.get('B')).toBeUndefined();
              expect(run.ctl.disposed.get('A')).toBe(1);
            });
          });
        });
      }
    }
  }
});
