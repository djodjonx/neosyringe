import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { MinIndexQueue } from '../../src/generator/minHeap';
import {
  EMITTERS,
  MATRIX,
  initializeText,
  label,
  member,
  withRun,
  type Cell,
  type Spec,
} from '../helpers/f-build';
import { FROZEN_INITIALIZE_FULL, FROZEN_INITIALIZE_MINIMAL } from './f11-frozen';

/**
 * F11 (topic 11) bounded concurrent initialization, at runtime, on the two emitters, full and minimal, open and closed.
 * Every factory reports to a controller the test owns and waits on a gate the test opens (a promise, no clock): a test
 * reads which factories started, how many ran at once and in which order, never a duration. No test types a method of the
 * container: the container is reached through `Reflect` on `unknown`.
 */

const names = (count: number, prefix: string): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const independent = (labels: readonly string[]): Spec[] => labels.map((name) => ({ name }));

/** An async/sync/multi/alias graph: the order its effects have at a concurrency of 1 is the order of cd61e36. */
const MIXED: readonly Spec[] = [
  { name: 'Db', dispose: true },
  { name: 'Cfg', kind: 'sync' },
  { name: 'Cache', deps: ['Db', 'Cfg'] },
  { name: 'Item', part: 'I0', deps: ['Db'] },
  { name: 'Item', part: 'I1', kind: 'sync' },
  { name: 'Item', part: 'I2' },
  { name: 'Rep', deps: ['*Item', 'Cache'] },
  { name: 'AL', alias: 'Rep' },
  { name: 'Svc', deps: ['AL'] },
];

/** `start:`/`end:` of every factory of {@link MIXED}, in the order cd61e36 ran them (captured on that source). */
const MIXED_LOG_AT_CD61E36: readonly string[] = [
  'start:Db', 'end:Db', 'start:Cfg', 'end:Cfg', 'start:Cache', 'end:Cache', 'start:I0', 'end:I0', 'start:I2', 'end:I2',
  'start:I1', 'end:I1', 'start:Rep', 'end:Rep', 'start:Svc', 'end:Svc',
];

const SIX = names(6, 'S');

/** The quoted token keys and the hash in the name of a creator depend on the virtual file; nothing else is changed. */
const normalise = (text: string): string => text
  .replace(/"[^"\n]*"/g, '"K"')
  .replace(/(I[A-Za-z0-9]*)_[0-9a-f]{8}/g, '$1_H');

function frozenFor(cell: Cell): string {
  return cell.emitter === 'optimized' && cell.profile === 'minimal' ? FROZEN_INITIALIZE_MINIMAL : FROZEN_INITIALIZE_FULL;
}

/** Mulberry32: a seeded generator, so a failing input can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const ERROR_ONE = new Error('first failure');
const ERROR_TWO = new Error('second failure');

describe('F11 N=1 keeps the sequential initialization of cd61e36', () => {
  for (const cell of MATRIX) {
    it(`P1 N=1 effect order equals cd61e36 order (${label(cell)})`, async () => {
      for (const options of [{}, { concurrency: 1 }]) {
        await withRun(cell, MIXED, options, async (run) => {
          const { settled } = run.start();
          expect((await settled).ok).toBe(true);
          expect(run.ctl.log).toEqual([...MIXED_LOG_AT_CD61E36]);
        });
      }
    });

    it(`P1 a concurrency of 1 and no concurrency write the same text, equal to the frozen initialize of cd61e36 (${label(cell)})`, async () => {
      const texts: string[] = [];
      for (const options of [{}, { concurrency: 1 }]) {
        await withRun(cell, MIXED, options, (run) => {
          texts.push(run.text);
          expect(normalise(initializeText(run.text))).toBe(frozenFor(cell));
          expect(run.text).not.toContain('__neoRunJobs');
        });
      }
      // The two sources differ by the option, so the keys of their tokens differ: compare the texts without them.
      expect(normalise(texts[0] ?? '')).toBe(normalise(texts[1] ?? ''));
    });

    it(`P1 N=1 a single rejection is the raw error object (${label(cell)})`, async () => {
      await withRun(cell, independent(['A', 'B']), { concurrency: 1 }, async (run) => {
        run.ctl.failWith('A', ERROR_ONE);
        const settled = await run.start().settled;
        expect(settled.ok).toBe(false);
        expect(settled.error).toBe(ERROR_ONE);
        expect(run.ctl.started).toEqual(['A']);
      });
    });
  }
});

describe('F11 N>1 runs at most N initialization steps at once', () => {
  for (const cell of MATRIX) {
    it(`P2 N=3 never exceeds 3 active and starts >=2 independent before release (${label(cell)})`, async () => {
      await withRun(cell, independent(SIX), { concurrency: 3 }, async (run) => {
        run.ctl.hold(...SIX);
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['S0', 'S1', 'S2']);
        expect(run.ctl.active()).toBe(3);
        run.ctl.open('S0');
        await run.settle();
        expect(run.ctl.started).toEqual(['S0', 'S1', 'S2', 'S3']);
        expect(run.ctl.active()).toBe(3);
        run.ctl.open('S1', 'S2');
        await run.settle();
        expect(run.ctl.started).toEqual(SIX);
        run.ctl.openAll();
        expect((await settled).ok).toBe(true);
        expect(run.ctl.peak()).toBe(3);
        expect([...run.ctl.built.values()]).toEqual([1, 1, 1, 1, 1, 1]);
      });
    });

    it(`P3 diamond: shared dep once, dependent after all deps (${label(cell)})`, async () => {
      const diamond: readonly Spec[] = [
        { name: 'A' },
        { name: 'B', deps: ['A'] },
        { name: 'C', deps: ['A'] },
        { name: 'D', deps: ['B', 'C'] },
      ];
      await withRun(cell, diamond, { concurrency: 3 }, async (run) => {
        run.ctl.hold('B', 'C');
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['A', 'B', 'C']);
        run.ctl.open('B');
        await run.settle();
        expect(run.ctl.started).toEqual(['A', 'B', 'C']);
        run.ctl.open('C');
        expect((await settled).ok).toBe(true);
        expect(run.ctl.built.get('A')).toBe(1);
        const log = run.ctl.log;
        expect(log.indexOf('start:D')).toBeGreaterThan(log.indexOf('end:B'));
        expect(log.indexOf('start:D')).toBeGreaterThan(log.indexOf('end:C'));
        expect(run.ctl.peak()).toBe(2);
      });
    });
  }
});

/** `A` needs `B` through something that is not an initialization step; `C` is independent and must run beside `B`. */
const THROUGH: ReadonlyArray<{ title: string; specs: readonly Spec[]; first: string }> = [
  {
    title: 'a sync service',
    specs: [{ name: 'B' }, { name: 'C' }, { name: 'S', kind: 'sync', deps: ['B'] }, { name: 'A', deps: ['S'] }],
    first: 'B',
  },
  {
    title: 'a multi token read with resolveAll',
    specs: [{ name: 'Item', part: 'M0' }, { name: 'C' }, { name: 'A', deps: ['*Item'] }],
    first: 'M0',
  },
  {
    title: 'an alias of a sync service',
    specs: [{ name: 'B' }, { name: 'C' }, { name: 'S', kind: 'sync', deps: ['B'] }, { name: 'AL', alias: 'S' }, { name: 'A', deps: ['AL'] }],
    first: 'B',
  },
  {
    title: 'a sync service behind a multi contribution',
    specs: [{ name: 'B' }, { name: 'C' }, { name: 'S', kind: 'sync', deps: ['B'] }, { name: 'Item', part: 'M0', kind: 'sync', deps: ['S'] }, { name: 'A', deps: ['*Item'] }],
    first: 'B',
  },
];

describe('F11 a step waits for every async step it reaches', () => {
  for (const cell of MATRIX) {
    for (const item of THROUGH) {
      it(`P4 async A reached through ${item.title}: A starts only after ${item.first} settled, at N=3 (${label(cell)})`, async () => {
        await withRun(cell, item.specs, { concurrency: 3 }, async (run) => {
          run.ctl.hold(item.first, 'C');
          const { settled } = run.start();
          await run.settle();
          expect([...run.ctl.started].sort()).toEqual([item.first, 'C'].sort());
          run.ctl.open(item.first);
          await run.settle();
          expect(run.ctl.started).toContain('A');
          expect(run.ctl.log.indexOf('start:A')).toBeGreaterThan(run.ctl.log.indexOf(`end:${item.first}`));
          run.ctl.open('C');
          expect((await settled).ok).toBe(true);
        });
      });
    }
  }
});

/**
 * An opaque factory (no `dependencies` list, `compatible` mode) declares nothing, so the graph cannot say what it reads.
 * Its step waits for every step of a lower rank; a step of a higher rank that does not reach it is not held back.
 */
const OPAQUE: ReadonlyArray<{ title: string; specs: readonly Spec[]; blocked: string; started: readonly string[] }> = [
  {
    title: 'an opaque async factory that resolves the async step B',
    specs: [{ name: 'B' }, { name: 'O', opaque: true, deps: ['B'] }],
    blocked: 'O',
    started: ['B', 'O'],
  },
  {
    title: 'an async step that reads an opaque sync factory that resolves B',
    specs: [{ name: 'B' }, { name: 'S', kind: 'sync', opaque: true, deps: ['B'] }, { name: 'A', deps: ['S'] }],
    blocked: 'A',
    started: ['B', 'S', 'A'],
  },
];

/** Closed mode refuses an opaque factory (NEO_CLOSED_REQUIRES_STRICT), so only the open cells have one. */
const OPEN_CELLS = MATRIX.filter((cell) => cell.mode === 'open');

describe('F11 an opaque factory waits for every step of a lower rank', () => {
  for (const cell of OPEN_CELLS) {
    for (const item of OPAQUE) {
      it(`P12 ${item.title}: ${item.blocked} does not start before B is released, at N=3 (${label(cell)})`, async () => {
        await withRun(cell, item.specs, { concurrency: 3 }, async (run) => {
          run.ctl.hold('B');
          const { settled } = run.start();
          await run.settle();
          expect(run.ctl.started).toEqual(['B']);
          run.ctl.open('B');
          expect((await settled).ok).toBe(true);
          expect(run.ctl.started).toEqual(item.started);
          expect(run.ctl.log.indexOf(`start:${item.blocked}`)).toBeGreaterThan(run.ctl.log.indexOf('end:B'));
        });
      });
    }

    it(`P12 an opaque step holds back no step of a higher rank that does not reach it (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'B' }, { name: 'O', opaque: true, deps: ['B'] }, { name: 'D' }];
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        run.ctl.hold('B');
        const { settled } = run.start();
        await run.settle();
        expect([...run.ctl.started].sort()).toEqual(['B', 'D']);
        run.ctl.open('B');
        expect((await settled).ok).toBe(true);
        expect(run.ctl.started).toEqual(['B', 'D', 'O']);
      });
    });

    it(`P12 an opaque step with a lower-rank step that fails: it never starts (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'B' }, { name: 'C' }, { name: 'O', opaque: true, deps: ['B'] }];
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        run.ctl.hold('C');
        run.ctl.failWith('C', ERROR_ONE);
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['B', 'C']);
        run.ctl.open('C');
        const outcome = await settled;
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBe(ERROR_ONE);
        expect(run.ctl.started).toEqual(['B', 'C']);
      });
    });
  }
});

/** The integers written in the `deps` lists of the jobs of an emitted container: `{ deps: [0, 1], run: ... }`. */
function emittedDeps(text: string): number[][] {
  return [...text.matchAll(/\{ deps: \[([^\]]*)\], run:/g)].map((found) =>
    (found[1] ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '').map(Number),
  );
}

describe('F11 an all-opaque graph writes a linear number of dependencies', () => {
  const STEPS = 200;
  for (const cell of OPEN_CELLS) {
    it(`P13 ${STEPS} opaque steps at N=3: at most 2 emitted dependencies per job on average, still one after the other (${label(cell)})`, async () => {
      const specs: readonly Spec[] = names(STEPS, 'O').map((name) => ({ name, opaque: true }));
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        const jobs = emittedDeps(run.text);
        expect(jobs).toHaveLength(STEPS);
        const total = jobs.reduce((sum, deps) => sum + deps.length, 0);
        expect(total).toBeLessThanOrEqual(2 * STEPS);
        expect((await run.start().settled).ok).toBe(true);
        expect(run.ctl.started).toEqual(specs.map((spec) => spec.name));
        expect(run.ctl.peak()).toBe(1);
      });
    });

    it(`P13 a second opaque step waits for the first one and for the free step between them, at N=3 (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'B' }, { name: 'O1', opaque: true }, { name: 'D' }, { name: 'O2', opaque: true }];
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        run.ctl.hold('B');
        const { settled } = run.start();
        await run.settle();
        expect([...run.ctl.started].sort()).toEqual(['B', 'D']);
        run.ctl.open('B');
        expect((await settled).ok).toBe(true);
        expect(run.ctl.started.slice(2)).toEqual(['O1', 'O2']);
        expect(run.ctl.log.indexOf('start:O2')).toBeGreaterThan(run.ctl.log.indexOf('end:O1'));
        expect(run.ctl.log.indexOf('start:O2')).toBeGreaterThan(run.ctl.log.indexOf('end:D'));
      });
    });
  }
});

describe('F11 the first failure stops new steps and joins the started ones', () => {
  for (const cell of MATRIX) {
    it(`P5 after the first failure queued steps never start; the active step finishes before the rollback; its owned value is disposed once (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'F1' }, { name: 'F2', dispose: true }, { name: 'Q3' }, { name: 'Q4' }];
      await withRun(cell, specs, { concurrency: 2 }, async (run) => {
        run.ctl.hold('F1', 'F2');
        run.ctl.failWith('F1', ERROR_ONE);
        const { settled } = run.start();
        let done = false;
        void settled.then(() => {
          done = true;
        });
        await run.settle();
        expect(run.ctl.started).toEqual(['F1', 'F2']);
        run.ctl.open('F1');
        await run.settle();
        expect(done).toBe(false);
        expect(run.ctl.started).toEqual(['F1', 'F2']);
        run.ctl.open('F2');
        const result = await settled;
        expect(result.ok).toBe(false);
        expect(result.error).toBe(ERROR_ONE);
        expect(run.ctl.started).toEqual(['F1', 'F2']);
        expect(run.ctl.disposed.get('F2')).toBe(1);
        expect(run.ctl.log.indexOf('dispose:F2')).toBeGreaterThan(run.ctl.log.indexOf('end:F2'));
      });
    });

    it(`P6 two rejections aggregate, the cause is the first one (${label(cell)})`, async () => {
      await withRun(cell, independent(['F1', 'F2']), { concurrency: 2 }, async (run) => {
        run.ctl.hold('F1', 'F2');
        run.ctl.failWith('F1', ERROR_ONE);
        run.ctl.failWith('F2', ERROR_TWO);
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['F1', 'F2']);
        run.ctl.open('F2');
        await run.settle();
        run.ctl.open('F1');
        const result = await settled;
        expect(result.ok).toBe(false);
        expect(result.error).toBeInstanceOf(AggregateError);
        if (!(result.error instanceof AggregateError)) return;
        expect(result.error.message).toBe('initialization failed');
        expect(result.error.errors).toHaveLength(2);
        expect(result.error.errors[0]).toBe(ERROR_TWO);
        expect(result.error.errors[1]).toBe(ERROR_ONE);
        expect(result.error.cause).toBe(ERROR_TWO);
      });
    });

    it(`P9 one rejection is the same Error object, not a wrapper (${label(cell)})`, async () => {
      await withRun(cell, independent(['F1', 'F2']), { concurrency: 2 }, async (run) => {
        run.ctl.hold('F1', 'F2');
        run.ctl.failWith('F2', ERROR_TWO);
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['F1', 'F2']);
        run.ctl.openAll();
        const result = await settled;
        expect(result.ok).toBe(false);
        expect(result.error).toBe(ERROR_TWO);
      });
    });
  }
});

describe('F11 the scheduler has one progress callback', () => {
  // 1001 factories per cell: the two emitters, full and open, are enough for the mechanism (it is one code path).
  const heavy = MATRIX.filter((cell) => cell.profile === 'full');
  for (const cell of heavy) {
    it(`P8 1 blocked + 1000 short, N=2: 1000 done while the slow one is pending, peak active 2, 0 repeated Promise.race registrations (${label(cell)})`, async () => {
      const labels = names(1000, 'F');
      await withRun(cell, independent(['Slow', ...labels]), { concurrency: 2 }, async (run) => {
        run.ctl.hold('Slow');
        const original: unknown = Reflect.get(Promise, 'race');
        if (typeof original !== 'function') throw new Error('Promise.race is not a function');
        const registrations = new Map<unknown, number>();
        // Test instrumentation only: count how often a still-active step is subscribed to by `Promise.race`.
        Reflect.set(Promise, 'race', (values: Iterable<unknown>) => {
          const entries = [...values];
          for (const entry of entries) registrations.set(entry, (registrations.get(entry) ?? 0) + 1);
          return Reflect.apply(original, Promise, [entries]);
        });
        let settledEarly = false;
        try {
          const { settled } = run.start();
          void settled.then(() => {
            settledEarly = true;
          });
          await run.settle();
          expect(labels.filter((name) => run.ctl.built.get(name) === 1)).toHaveLength(1000);
          expect(run.ctl.peak()).toBe(2);
          expect(settledEarly).toBe(false);
          expect(Math.max(0, ...registrations.values())).toBeLessThanOrEqual(1);
          run.ctl.open('Slow');
          expect((await settled).ok).toBe(true);
          expect(run.ctl.built.get('Slow')).toBe(1);
        } finally {
          Reflect.set(Promise, 'race', original);
        }
      });
    }, 60000);
  }
});

describe('F11 the emitted runtime heap pops like the compile-time queue', () => {
  for (const emitter of EMITTERS) {
    it(`P1 heap parity: emitted runtime heap pops like MinIndexQueue (${emitter}, 500 random jobs)`, async () => {
      await withRun({ emitter, profile: 'full', mode: 'open' }, independent(['A', 'B']), { concurrency: 2 }, async (run) => {
        const runJobs = member(run.box, '__neoRunJobs');
        expect(runJobs, 'the container has the scheduler member').toBeDefined();
        if (runJobs === undefined) return;
        const next = random(20260511);
        const count = 500;
        // A hidden order makes every edge go from an earlier to a later position, so the graph is acyclic; the job
        // indexes (the priority) are a shuffle of it, so the order of the indexes is not an order of the edges.
        const position = Array.from({ length: count }, (_, index) => index).sort(() => next() - 0.5);
        const dependencies: number[][] = Array.from({ length: count }, () => []);
        for (let job = 0; job < count; job += 1) {
          for (let tries = 0; tries < 3; tries += 1) {
            const other = Math.floor(next() * count);
            if ((position[other] ?? 0) < (position[job] ?? 0) && !dependencies[job]?.includes(other)) dependencies[job]?.push(other);
          }
        }
        const expected: number[] = [];
        const pending = dependencies.map((list) => list.length);
        const queue = new MinIndexQueue();
        pending.forEach((remaining, job) => {
          if (remaining === 0) queue.push(job);
        });
        while (queue.size > 0) {
          const job = queue.pop();
          expected.push(job);
          dependencies.forEach((list, other) => {
            if (!list.includes(job)) return;
            pending[other] = (pending[other] ?? 1) - 1;
            if (pending[other] === 0) queue.push(other);
          });
        }
        const seen: number[] = [];
        const jobs = dependencies.map((deps, job) => ({
          deps,
          run: async (): Promise<void> => {
            seen.push(job);
          },
        }));
        await runJobs(jobs, 1);
        expect(expected).toHaveLength(count);
        expect(seen).toEqual(expected);
      });
    });
  }
});

describe('F11 boundaries', () => {
  for (const cell of MATRIX) {
    it(`P11 N larger than the number of steps is bounded by the steps (${label(cell)})`, async () => {
      await withRun(cell, independent(['A', 'B']), { concurrency: 10 }, async (run) => {
        run.ctl.hold('A', 'B');
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['A', 'B']);
        // The bound written in the output is the number of steps, not the 10 asked for.
        expect(run.text).toContain('], 2);');
        run.ctl.openAll();
        expect((await settled).ok).toBe(true);
        expect(run.ctl.peak()).toBe(2);
      });
    });

    it(`P11 a sync dependency that throws while a step runs rejects with that error, after the other active step (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'S', kind: 'sync' }, { name: 'A', deps: ['S'] }, { name: 'B' }];
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        run.ctl.hold('B');
        run.ctl.failWith('S', ERROR_ONE);
        const { settled } = run.start();
        let done = false;
        void settled.then(() => {
          done = true;
        });
        await run.settle();
        // A declared dependency is read before the factory body runs: the sync `S` starts, and throws, before `A` does.
        expect(run.ctl.started).toEqual(['S', 'B']);
        expect(done).toBe(false);
        run.ctl.open('B');
        const result = await settled;
        expect(result.ok).toBe(false);
        expect(result.error).toBe(ERROR_ONE);
      });
    });

    it(`P11 destroy during an N=3 initialization joins the active steps and disposes their values once (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'A', dispose: true }, { name: 'B', dispose: true }, { name: 'C', dispose: true }];
      await withRun(cell, specs, { concurrency: 3 }, async (run) => {
        run.ctl.hold('A', 'B', 'C');
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['A', 'B', 'C']);
        const destroy = member(run.box, 'destroy');
        expect(destroy).toBeDefined();
        if (destroy === undefined) return;
        const destroyed = Promise.resolve(destroy());
        let closed = false;
        void destroyed.then(() => {
          closed = true;
        });
        await run.settle();
        expect(closed).toBe(false);
        run.ctl.openAll();
        await destroyed;
        await settled;
        expect([...run.ctl.disposed.entries()].sort()).toEqual([['A', 1], ['B', 1], ['C', 1]]);
        const log = run.ctl.log;
        const ends = ['A', 'B', 'C'].map((name) => log.indexOf(`end:${name}`));
        const disposals = ['A', 'B', 'C'].map((name) => log.indexOf(`dispose:${name}`));
        expect(Math.min(...disposals)).toBeGreaterThan(Math.max(...ends));
      });
    });

    if (cell.mode === 'open') {
      it(`P11 a parent destroyed while the child waits for it is refused before any step starts (${label(cell)})`, async () => {
        await withRun(cell, independent(['A', 'B']), { concurrency: 2, parent: [{ name: 'Par' }] }, async (run) => {
          run.ctl.hold('Par');
          const { settled } = run.start();
          await run.settle();
          expect(run.ctl.started).toEqual(['Par']);
          const destroyParent = run.parent === undefined ? undefined : member(run.parent, 'destroy');
          expect(destroyParent).toBeDefined();
          if (destroyParent === undefined) return;
          const parentDestroyed = Promise.resolve(destroyParent());
          run.ctl.open('Par');
          const result = await settled;
          await parentDestroyed;
          expect(result.ok).toBe(false);
          expect(result.error instanceof Error ? Reflect.get(result.error, 'code') : undefined).toBe('NEO_SCOPE_PARENT_DESTROYED');
          expect(run.ctl.started).toEqual(['Par']);
        });
      });
    }

    it(`P11 a container without an async service is untouched by the option (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'S', kind: 'sync' }], { concurrency: 3 }, async (run) => {
        expect(run.text).not.toContain('__neoRunJobs');
        const settled = await run.start().settled;
        expect(settled.ok).toBe(true);
      });
    });
  }

  for (const cell of MATRIX.filter((item) => item.mode === 'closed')) {
    it(`P11 eager lines stay after every step (${label(cell)})`, async () => {
      const specs: readonly Spec[] = [{ name: 'A' }, { name: 'B' }, { name: 'Eg', kind: 'sync' }];
      await withRun(cell, specs, { concurrency: 2, eager: ['Eg'] }, async (run) => {
        run.ctl.hold('A', 'B');
        const { settled } = run.start();
        await run.settle();
        expect(run.ctl.started).toEqual(['A', 'B']);
        run.ctl.openAll();
        expect((await settled).ok).toBe(true);
        const log = run.ctl.log;
        expect(log.indexOf('start:Eg')).toBeGreaterThan(log.indexOf('end:A'));
        expect(log.indexOf('start:Eg')).toBeGreaterThan(log.indexOf('end:B'));
      });
    });
  }
});

describe('F11 what is emitted', () => {
  for (const cell of MATRIX) {
    it(`P2 the scheduler is emitted only when a concurrency above 1 meets at least two steps; a sync service is not a step (${label(cell)})`, async () => {
      const lines = (text: string): number => text.split('run: async').length - 1;
      await withRun(cell, [{ name: 'A' }, { name: 'B' }, { name: 'T', kind: 'sync' }], { concurrency: 3 }, (run) => {
        expect(run.text).toContain('__neoRunJobs');
        expect(lines(run.text)).toBe(2);
      });
      await withRun(cell, [{ name: 'A' }], { concurrency: 3 }, (run) => {
        expect(run.text).not.toContain('__neoRunJobs');
      });
      await withRun(cell, [{ name: 'A' }, { name: 'B' }], { concurrency: 1 }, (run) => {
        expect(run.text).not.toContain('__neoRunJobs');
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// A graph built by hand: a constraint cycle no service cycle shows
// ---------------------------------------------------------------------------------------------------------------

function anchor(): ts.CallExpression {
  const sourceFile = ts.createSourceFile(
    'synthetic.ts',
    'declare function defineBuilderConfig(config: unknown): unknown;\ndefineBuilderConfig({});\n',
    ts.ScriptTarget.ES2022,
    true,
  );
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error('missing call');
  return found;
}

function asyncNode(tokenId: string, reads: string, all: boolean): DependencyNode {
  const service: ServiceDefinition = {
    tokenId,
    registrationNode: anchor(),
    registrationId: tokenId,
    type: 'factory',
    lifecycle: 'singleton',
    isInterfaceToken: true,
    factorySource: 'async () => ({})',
    isAsync: true,
    factoryDependencies: [{ tokenId: reads, all, source: 'ctx', containerId: 'F11Cycle' }],
  };
  return { service, dependencies: [reads] };
}

/** `A` reads every contribution of the multi token `M`, and the contribution reads `A`: a cycle the topological sort does not see. */
function cycleGraph(concurrency: number | undefined): DependencyGraph {
  const base: DependencyGraph = {
    containerId: 'F11Cycle',
    containerName: 'F11Cycle',
    nodes: new Map([['A', asyncNode('A', 'M', true)]]),
    multiNodes: new Map([['M', [asyncNode('M', 'A', false)]]]),
    roots: [],
    sourceFileName: '/virtual/f11-cycle.ts',
    defineBuilderConfigStart: 0,
  };
  return concurrency === undefined ? base : Object.assign(base, { initializationConcurrency: concurrency });
}

describe('F11 a cycle between steps is refused before any effect', () => {
  for (const emitter of EMITTERS) {
    it(`P10 cycle in a hand-built async graph refused at generation (${emitter})`, () => {
      expect(() => new Generator(cycleGraph(3), false, undefined, false, false, emitter).generate()).toThrow(/cycle/i);
    });
  }
});
