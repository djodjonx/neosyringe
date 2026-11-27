import { describe, expect, it } from 'vitest';
import { MATRIX, label, member, withRun, type Run } from '../helpers/f-build';

/**
 * Stage F, runtime cost of the cancellation signal (docs/benchmarks/stage-f-compile-overhead.md, "Runtime cost"). An
 * `initialize()` that nobody can cancel and no factory observes used to build a native `AbortController`, a promise and
 * two closures. The controller is now made when something reads a signal that can abort: the first `context.signal` read
 * during the initialization. These tests read what a user observes: how many controllers the runtime was asked for, and
 * the signal a factory gets when it reads it late (after the abort, or after `destroy()` began), which must be born aborted
 * with the same reason as the signal of a factory that read it at once. The container is reached through `Reflect`.
 */

const REASON = new Error('stop initializing');

function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method = member(owner, name);
  if (method === undefined) throw new Error(`missing member ${name}`);
  return method(...args);
}

function objectOf(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return value;
}

function codeOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

function abortedOf(signal: unknown): boolean | undefined {
  if (typeof signal !== 'object' || signal === null) return undefined;
  const aborted: unknown = Reflect.get(signal, 'aborted');
  return typeof aborted === 'boolean' ? aborted : undefined;
}

function reasonOf(signal: unknown): unknown {
  return typeof signal === 'object' && signal !== null ? Reflect.get(signal, 'reason') : undefined;
}

/** What a promise did so far, read without waiting for it; a rejection is observed here, never left unhandled. */
function watch(promise: unknown): { done: boolean } {
  const watched = { done: false };
  if (!(promise instanceof Promise)) throw new Error('not a promise');
  promise.then(
    () => {
      watched.done = true;
    },
    () => {
      watched.done = true;
    },
  );
  return watched;
}

/** The `signal` of the context the factory `name` was called with, read now (the factory is still running). */
function readNow(run: Run, name: string): unknown {
  return Reflect.get(objectOf(run.ctl.contexts.get(name)), 'signal');
}

/** Counts the controllers the runtime is asked for, while `scenario` runs; the global is always put back. */
async function countingControllers(scenario: () => Promise<void>): Promise<number> {
  const Native = globalThis.AbortController;
  let constructed = 0;
  class Counting extends Native {
    constructor() {
      super();
      constructed += 1;
    }
  }
  Reflect.set(globalThis, 'AbortController', Counting);
  try {
    await scenario();
  } finally {
    Reflect.set(globalThis, 'AbortController', Native);
  }
  return constructed;
}

describe('PA an initialization nobody can cancel and no factory observes builds no controller', () => {
  for (const cell of MATRIX) {
    it(`PA1 initialize() without options, factories that never read the signal: no AbortController is constructed, and the container is ready (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], {}, async (run) => {
        run.ctl.readSignal = false;
        const constructed = await countingControllers(async () => {
          expect((await run.start().settled).ok).toBe(true);
        });
        expect(run.ctl.started).toEqual(['A', 'B']);
        expect(Reflect.get(objectOf(call(run.box, 'resolve', run.token('B'))), 'name')).toBe('B');
        expect(constructed).toBe(0);
      });
    });

    it(`PA2 initialize({ signal }), factories that never read the signal: no AbortController is constructed either, and the listener is gone once ready (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], {}, async (run) => {
        run.ctl.readSignal = false;
        const user = new AbortController();
        const constructed = await countingControllers(async () => {
          expect((await run.start({ signal: user.signal }).settled).ok).toBe(true);
        });
        expect(constructed).toBe(0);
        // A late abort of the caller's signal changes nothing: the initialization is over.
        user.abort(REASON);
        expect(Reflect.get(objectOf(call(run.box, 'resolve', run.token('B'))), 'name')).toBe('B');
      });
    });

    it(`PA4 a call without a signal answers the work itself: a second call without options while it runs is the identical promise (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], {}, async (run) => {
        run.ctl.hold('A');
        const first = run.start();
        await run.settle();
        const second = call(run.box, 'initialize');
        expect(second).toBe(first.promise);
        run.ctl.openAll();
        expect((await first.settled).ok).toBe(true);
        // Once ready, a call answers a resolved promise; nothing starts again.
        await call(run.box, 'initialize');
        expect(run.ctl.started).toEqual(['A', 'B']);
      });
    });

    it(`PA5 a join made during the synchronous part of the first call (an observe() sink calls initialize() on the first event) waits for the work: not settled before the factory is released, then settled ok (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], { observation: true }, async (run) => {
        run.ctl.hold('A');
        let joined: unknown;
        let joins = 0;
        const stop = call(run.box, 'observe', () => {
          joins += 1;
          if (joins === 1) joined = call(run.box, 'initialize');
        });
        try {
          const first = run.start();
          const early = watch(joined);
          await run.settle();
          await run.settle();
          expect(joins, 'the sink ran during the first call').toBeGreaterThan(0);
          expect(early.done, 'the join is still pending while factory A is held').toBe(false);
          run.ctl.openAll();
          expect((await first.settled).ok).toBe(true);
          await run.settle();
          expect(early.done, 'the join settles with the work').toBe(true);
          await joined;
        } finally {
          if (typeof stop === 'function') Reflect.apply(stop, undefined, []);
        }
      });
    });

    // The minimal profile of the optimized emitter has no `override`: the reconfiguration is a full-profile member.
    it.runIf(cell.profile === 'full')(`PA6 the same join during the first call of a second initialization (after a reconfiguration) is not the stale promise of the first one (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], { observation: true, testOverrides: true }, async (run) => {
        const firstRun = run.start();
        expect((await firstRun.settled).ok).toBe(true);
        const stale = firstRun.promise;
        await call(run.box, 'override', run.token('A'), () => ({ name: 'A2' }));
        run.ctl.hold('B');
        let joined: unknown;
        let joins = 0;
        const stop = call(run.box, 'observe', () => {
          joins += 1;
          if (joins === 1) joined = call(run.box, 'initialize');
        });
        try {
          const second = run.start();
          const early = watch(joined);
          await run.settle();
          await run.settle();
          expect(joins, 'the sink ran during the second call').toBeGreaterThan(0);
          expect(joined, 'the join is not the promise of the first initialization').not.toBe(stale);
          expect(early.done, 'the join is still pending while factory B is held').toBe(false);
          run.ctl.openAll();
          expect((await second.settled).ok).toBe(true);
          await run.settle();
          expect(early.done).toBe(true);
        } finally {
          if (typeof stop === 'function') Reflect.apply(stop, undefined, []);
        }
      });
    });

    it(`PA3 factories that read the signal share the one controller of the initialization: exactly one is constructed, and it is the signal they got (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], {}, async (run) => {
        const constructed = await countingControllers(async () => {
          expect((await run.start().settled).ok).toBe(true);
        });
        expect(constructed).toBe(1);
        const first = run.ctl.signals.get('A');
        expect(first).toBeInstanceOf(AbortSignal);
        expect(run.ctl.signals.get('B')).toBe(first);
      });
    });
  }
});

describe('PB a signal read late is born aborted, with the reason of the first abort', () => {
  for (const cell of MATRIX) {
    it(`PB1 destroy() began, then the running factory reads context.signal: it is aborted with NEO_CONTAINER_DESTROYED (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        run.ctl.readSignal = false;
        run.ctl.hold('A');
        const initialized = watch(run.start().promise);
        await run.settle();
        const closing = watch(call(run.box, 'destroy'));
        const late = readNow(run, 'A');
        expect(abortedOf(late)).toBe(true);
        expect(codeOf(reasonOf(late))).toBe('NEO_CONTAINER_DESTROYED');
        run.ctl.openAll();
        await run.settle();
        await run.settle();
        expect(initialized.done).toBe(true);
        expect(closing.done).toBe(true);
      });
    });

    it(`PB2 the caller's signal aborted, then the running factory reads context.signal: it is aborted with the caller's reason (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        run.ctl.readSignal = false;
        run.ctl.hold('A');
        const user = new AbortController();
        const initialized = watch(run.start({ signal: user.signal }).promise);
        await run.settle();
        user.abort(REASON);
        const late = readNow(run, 'A');
        expect(abortedOf(late)).toBe(true);
        expect(reasonOf(late)).toBe(REASON);
        run.ctl.openAll();
        await run.settle();
        await run.settle();
        expect(initialized.done).toBe(true);
      });
    });

    it(`PB3 destroy() first, then the caller's abort, then a late read: the first reason wins, as for a signal read at once (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        run.ctl.readSignal = false;
        run.ctl.hold('A');
        const user = new AbortController();
        const initialized = watch(run.start({ signal: user.signal }).promise);
        await run.settle();
        const closing = watch(call(run.box, 'destroy'));
        user.abort(REASON);
        const late = readNow(run, 'A');
        expect(abortedOf(late)).toBe(true);
        expect(codeOf(reasonOf(late))).toBe('NEO_CONTAINER_DESTROYED');
        run.ctl.openAll();
        await run.settle();
        await run.settle();
        expect(initialized.done).toBe(true);
        expect(closing.done).toBe(true);
      });
    });

    it(`PB4 the caller's abort first, then destroy(), then a late read: the caller's reason wins (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        run.ctl.readSignal = false;
        run.ctl.hold('A');
        const user = new AbortController();
        const initialized = watch(run.start({ signal: user.signal }).promise);
        await run.settle();
        user.abort(REASON);
        const closing = watch(call(run.box, 'destroy'));
        const late = readNow(run, 'A');
        expect(abortedOf(late)).toBe(true);
        expect(reasonOf(late)).toBe(REASON);
        run.ctl.openAll();
        await run.settle();
        await run.settle();
        expect(initialized.done).toBe(true);
        expect(closing.done).toBe(true);
      });
    });

    // The minimal profile of the optimized emitter has no `override`: the reconfiguration is a full-profile member.
    it.runIf(cell.profile === 'full')(`PB6 a second initialization after a reconfiguration gets its own signal, not the one the first handed out (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B', deps: ['A'] }], { testOverrides: true }, async (run) => {
        expect((await run.start().settled).ok).toBe(true);
        const first = run.ctl.signals.get('B');
        expect(abortedOf(first)).toBe(false);
        // `override` closes the cache and puts the container back to `created`: the next `initialize()` is a new one.
        await call(run.box, 'override', run.token('A'), () => ({ name: 'A2' }));
        expect((await run.start().settled).ok).toBe(true);
        const second = run.ctl.signals.get('B');
        expect(abortedOf(second)).toBe(false);
        expect(second).not.toBe(first);
      });
    });

    it(`PB5 nothing aborted, a late read: the signal is the live one of the initialization, and it aborts afterwards (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        run.ctl.readSignal = false;
        run.ctl.hold('A');
        const user = new AbortController();
        const initialized = watch(run.start({ signal: user.signal }).promise);
        await run.settle();
        const late = readNow(run, 'A');
        expect(abortedOf(late)).toBe(false);
        user.abort(REASON);
        expect(abortedOf(late)).toBe(true);
        expect(reasonOf(late)).toBe(REASON);
        run.ctl.openAll();
        await run.settle();
        await run.settle();
        expect(initialized.done).toBe(true);
      });
    });
  }
});

describe('PC an observed disposal begins and ends exactly once, even when the value it returns fails a second read of then', () => {
  for (const cell of MATRIX) {
    it(`PC1 dispose() answers an object whose then getter throws on its second read: one end event for the disposal (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', dispose: true, disposeTwoFaced: true }], { observation: true }, async (run) => {
        expect((await run.start().settled).ok).toBe(true);
        const events: object[] = [];
        const stop = call(run.box, 'observe', (event: unknown) => {
          if (typeof event === 'object' && event !== null) events.push(event);
        });
        try {
          const closing = await Promise.resolve(call(run.box, 'destroy')).then(
            () => undefined,
            (error: unknown) => error,
          );
          const disposals = events.map((event) => `${String(Reflect.get(event, 'phase'))}:${String(Reflect.get(event, 'kind'))}`).filter((entry) => entry.startsWith('dispose:'));
          expect(disposals).toEqual(['dispose:start', 'dispose:end']);
          expect(closing, 'the first read saw a plain value: destroy() succeeds').toBeUndefined();
        } finally {
          if (typeof stop === 'function') Reflect.apply(stop, undefined, []);
        }
      });
    });
  }
});

describe('PD one factory context class and one context type per container, whatever the number of factories', () => {
  for (const cell of MATRIX) {
    // A closed container refuses an opaque factory (NEO_CLOSED_REQUIRES_STRICT): its cells have declared factories only.
    const opaque = cell.mode === 'open';
    const specs = [
      { name: 'A' },
      { name: 'B', deps: ['A'] },
      { name: 'C', deps: ['A'], opaque },
      { name: 'D', deps: ['A'], opaque },
      { name: 'E', kind: 'sync' as const },
    ];
    it(`PD1 several factories (${opaque ? 'declared and opaque' : 'declared'}) write the context class once and its type literal once, and every factory gets a working context (${label(cell)})`, async () => {
      await withRun(cell, specs, {}, async (run) => {
        expect(run.text.match(/private static readonly __neoContext\w* = class/g) ?? [], 'one context class').toHaveLength(1);
        expect(run.text.match(/readonly signal: \w+Signal; resolve<T>\(token: unknown\)/g) ?? [], 'one context type literal').toHaveLength(1);
        expect((await run.start().settled).ok).toBe(true);
        expect(run.ctl.started.sort()).toEqual(['A', 'B', 'C', 'D']);
        for (const name of ['A', 'B', 'C', 'D']) expect(abortedOf(run.ctl.signals.get(name)), `${name} read a signal`).toBe(false);
      });
    });
  }
});

describe('PE the signal of a factory context is an accessor of its prototype (documented in docs/api/types.md and docs/guide/migration.md)', () => {
  for (const cell of MATRIX) {
    it(`PE1 ctx.signal and destructuring read it; a spread copy and Object.keys do not have it, and the own members are the three resolvers and __neoRead (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }], {}, async (run) => {
        expect((await run.start().settled).ok).toBe(true);
        const context = objectOf(run.ctl.contexts.get('A'));
        expect(run.ctl.signals.get('A')).toBeInstanceOf(AbortSignal);
        expect(Object.keys(context).sort()).toEqual(['__neoRead', 'resolve', 'resolveAll', 'resolveMany']);
        expect(Object.keys({ ...context })).not.toContain('signal');
        expect(Reflect.getOwnPropertyDescriptor(context, 'signal')).toBeUndefined();
        expect('signal' in context).toBe(true);
      });
    });
  }
});
