import * as diagnosticsChannel from 'node:diagnostics_channel';
import { setImmediate as tick } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { build } from '../helpers/e17-build';
import { MATRIX as INPUT_CELLS, label as inputLabel, withEnv } from '../helpers/e18-build';
import { MATRIX, label, member, sourceOf, withRun, type Cell, type Run, type Spec } from '../helpers/f-build';
import { loadSource } from '../helpers/t06-run';
import * as neosyringe from '../../../neosyringe/src/index';

/**
 * F22 (topic 22) optional production observation, at runtime, on the two emitters, full and minimal, open and closed. The
 * build option is off by default: the container then has no `observe()`, no `stateSnapshot()` and reads no clock. On, the
 * container publishes a start and an end event around each construct, initialize step and dispose, and answers a scalar
 * snapshot of its state. Every factory waits on a gate the test opens (a promise, no clock). The clock of a subscriber is
 * injected through `observe(sink, { now })`: a counting clock the test owns. Only the rows about the default clock
 * (`performance.now`, read when a sink is subscribed and never otherwise) stub it, and the stub only counts the reads that
 * the emitted code makes. A test reads what a user can observe: the events a sink receives, what a call resolves or
 * rejects with, the snapshot. No test types a method of the container: it is reached through `Reflect` on `unknown`.
 */

const FACTORY_ERROR = new Error('factory secret message');
const DISPOSE_ERROR = new Error('dispose secret message');
const REASON = new Error('stop initializing');

const EVENT_KEYS = ['containerId', 'kind', 'phase', 'registrationId', 'scopeId'];
const END_KEYS = [...EVENT_KEYS, 'durationMs', 'outcome'].sort();
const SNAPSHOT_KEYS = ['activeScopes', 'cancellations', 'constructs', 'disposes', 'failures', 'inFlight', 'initializes', 'state'];

type Sink = (event: unknown) => unknown;

interface Recorder {
  sink: Sink;
  events: object[];
}

function recorder(): Recorder {
  const events: object[] = [];
  return {
    events,
    sink: (event) => {
      if (typeof event === 'object' && event !== null) events.push(event);
    },
  };
}

/** A clock the test owns: every read answers the next integer, and `reads()` says how many there were. */
function countingClock(): { now: () => number; reads: () => number } {
  let reads = 0;
  return {
    now: () => {
      reads += 1;
      return reads;
    },
    reads: () => reads,
  };
}

function objectOf(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return value;
}

const CELL: Cell = { emitter: 'optimized', profile: 'full', mode: 'open' };

const HEAD_22 = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
interface Probe { log: string[]; saved: unknown[]; counts: Record<string, number>; fail?: Error }
declare const probe: Probe;
`;

function entriesOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function keysOf(value: unknown): string[] {
  return Object.keys(entriesOf(value)).sort();
}

/** `owner[name](...args)`; a missing member is an assertion that fails, never a TypeError. */
function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method = member(owner, name);
  expect(method, `the container has ${name}()`).toBeDefined();
  return method === undefined ? undefined : method(...args);
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** `box.observe(sink, { now })`: the unsubscribe function. */
function subscribe(box: object, sink: (event: never) => unknown, now?: () => number): () => void {
  const stop = call(box, 'observe', sink, now === undefined ? undefined : { now });
  expect(typeof stop, 'observe() answers the unsubscribe function').toBe('function');
  return () => {
    if (typeof stop === 'function') Reflect.apply(stop, undefined, []);
  };
}

function snapshotOf(box: object): Record<string, unknown> {
  const snapshot = call(box, 'stateSnapshot');
  expect(typeof snapshot, 'stateSnapshot() answers an object').toBe('object');
  return entriesOf(snapshot);
}

function inFlightOf(snapshot: Record<string, unknown>): Record<string, unknown> {
  return entriesOf(snapshot.inFlight);
}

/** `phase:kind:name[:outcome]` of each event, where `name` is the spec the registration id belongs to. */
function trace(run: Run, names: readonly string[], events: readonly object[]): string[] {
  const ids = new Map(names.map((name) => [run.token(name), name]));
  return events.map((event) => {
    const fields = entriesOf(event);
    const id = typeof fields.registrationId === 'string' ? (ids.get(fields.registrationId) ?? fields.registrationId) : '?';
    const tail = fields.kind === 'end' ? `:${String(fields.outcome)}` : '';
    return `${String(fields.phase)}:${String(fields.kind)}:${id}${tail}`;
  });
}

/** Every start has its end, once: the starts and the ends of one operation are equal in number. */
function expectBalanced(events: readonly object[]): void {
  const open = new Map<string, number>();
  for (const event of events) {
    const fields = entriesOf(event);
    const key = `${String(fields.scopeId)}|${String(fields.registrationId)}|${String(fields.phase)}`;
    open.set(key, (open.get(key) ?? 0) + (fields.kind === 'start' ? 1 : -1));
  }
  for (const [key, count] of open) expect(count, key).toBe(0);
}

/** Runs `scenario` with `performance.now` counting the reads made by the emitted code, then restores it. */
async function withClockStub<T>(scenario: (reads: () => number) => Promise<T>): Promise<T> {
  const target: object = globalThis.performance;
  const original = Object.getOwnPropertyDescriptor(target, 'now');
  const previous: unknown = Reflect.get(target, 'now');
  if (typeof previous !== 'function') throw new Error('performance.now is not a function');
  let reads = 0;
  Object.defineProperty(target, 'now', {
    configurable: true,
    writable: true,
    value: (): unknown => {
      // Only a read from code the harness evaluated with `new Function` counts: the test runner reads the clock too.
      if (/eval at /.test(new Error().stack ?? '')) reads += 1;
      return Reflect.apply(previous, target, []);
    },
  });
  try {
    return await scenario(() => reads);
  } finally {
    if (original === undefined) Reflect.deleteProperty(target, 'now');
    else Object.defineProperty(target, 'now', original);
  }
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

const independent = (names: readonly string[]): Spec[] => names.map((name) => ({ name, dispose: true }));

describe('F22 observation is off by default: no member, no helper, no clock', () => {
  for (const cell of MATRIX) {
    it(`O1 off: the output has no observation, the text equals the text without the option, no clock is read (${label(cell)})`, async () => {
      const specs: Spec[] = [{ name: 'A', dispose: true }, { name: 'B', kind: 'sync', dispose: true }];
      // The same graph, opened without the option and with it false: the text of the container is the same.
      const loaded = loadSource(sourceOf(cell, specs));
      const absent = loaded.open('box', { emitter: cell.emitter });
      const off = loaded.open('box', { emitter: cell.emitter, observation: false });
      try {
        expect(off.source).toBe(absent.source);
        expect(absent.source).not.toMatch(/\bobserve\b|stateSnapshot|_neoObs\(|performance|ContainerObs/);
        expect(Reflect.get(absent.container, 'observe')).toBeUndefined();
        expect(Reflect.get(absent.container, 'stateSnapshot')).toBeUndefined();
      } finally {
        await absent.container.destroy();
        await off.container.destroy();
      }
      await withClockStub(async (reads) => {
        await withRun(cell, specs, {}, async (run) => {
          await run.start().promise;
          call(run.box, 'resolve', run.token('B'));
          const scope = call(run.box, 'createScope');
          await call(objectOf(scope), 'destroy');
        });
        expect(reads()).toBe(0);
      });
    });
  }
});

describe('F22 on, without a subscriber: no clock read, no meta object, counters still count', () => {
  for (const cell of MATRIX) {
    it(`O2 on without a subscriber: zero clock reads, and the snapshot counts what ran (${label(cell)})`, async () => {
      await withClockStub(async (reads) => {
        await withRun(cell, [{ name: 'A', dispose: true }, { name: 'B', kind: 'sync', dispose: true }], { observation: true }, async (run) => {
          expect(typeof Reflect.get(run.box, 'observe'), 'the build has observation').toBe('function');
          await run.start().promise;
          call(run.box, 'resolve', run.token('B'));
          const snapshot = snapshotOf(run.box);
          expect(snapshot.constructs).toBe(2);
          expect(snapshot.initializes).toBe(1);
          expect(snapshot.failures).toBe(0);
          expect(inFlightOf(snapshot)).toEqual({ construct: 0, initialize: 0, dispose: 0 });
          // A scope is a container of the class: it counts and it destroys without a clock.
          const scope = objectOf(call(run.box, 'createScope'));
          await call(scope, 'destroy');
          await call(run.box, 'destroy');
          expect(snapshotOf(run.box).disposes).toBe(2);
        });
        expect(reads()).toBe(0);
      });
    });

    it(`O2 the call sites build no meta: the meta literal sits behind the subscriber test inside the helper (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, (run) => {
        const text = run.text;
        const guard = text.indexOf('this._subs.length === 0');
        const meta = text.indexOf('containerId: this._containerId');
        expect(guard, 'the helper tests for a subscriber').toBeGreaterThan(-1);
        expect(meta, 'the helper builds the meta').toBeGreaterThan(-1);
        expect(guard).toBeLessThan(meta);
        // A call site passes scalars: the container never writes a meta literal of its own.
        expect(text.split('containerId: this._containerId').length - 1).toBe(1);
      });
    });
  }

  it('O2 the default clock is performance.now, read when a sink is subscribed and never before or after', async () => {
    await withClockStub(async (reads) => {
      await withRun(CELL, [{ name: 'A', kind: 'sync', dispose: true }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        call(run.box, 'resolve', run.token('A'));
        expect(reads()).toBe(0);
        const events = recorder();
        const stop = subscribe(run.box, events.sink);
        call(run.box, 'resolve', run.token('B'));
        // One construct: one read at its start and one at its end.
        expect(reads()).toBe(2);
        expect(events.events).toHaveLength(2);
        stop();
        await call(run.box, 'destroy');
        expect(reads()).toBe(2);
        expect(events.events).toHaveLength(2);
      });
    });
  });
});

describe('F22 construct, initialize and dispose events', () => {
  for (const cell of MATRIX) {
    it(`O3 a singleton is built once: one start and one end, a cache hit emits none, the duration comes from the injected clock, a dependency nests (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync', deps: ['B'] }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const events = recorder();
        const clock = countingClock();
        subscribe(run.box, events.sink, clock.now);
        call(run.box, 'resolve', run.token('A'));
        expect(trace(run, ['A', 'B'], events.events)).toEqual([
          'construct:start:A',
          'construct:start:B',
          'construct:end:B:ok',
          'construct:end:A:ok',
        ]);
        // The clock was read once at each start and once at each end, and a duration is the difference of the two reads.
        expect(clock.reads()).toBe(4);
        const durations = events.events.filter((event) => entriesOf(event).kind === 'end').map((event) => entriesOf(event).durationMs);
        expect(durations).toEqual([1, 3]);
        call(run.box, 'resolve', run.token('A'));
        call(run.box, 'resolve', run.token('B'));
        expect(events.events).toHaveLength(4);
        expectBalanced(events.events);
      });
    });

    it(`O3 an async singleton is observed at its settlement: initialize and construct start together, both end after the factory settles (${label(cell)})`, async () => {
      await withRun(cell, independent(['A']), { observation: true }, async (run) => {
        run.ctl.hold('A');
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        const started = run.start();
        await run.settle();
        expect(trace(run, ['A'], events.events)).toEqual(['initialize:start:A', 'construct:start:A']);
        run.ctl.open('A');
        await started.promise;
        expect(trace(run, ['A'], events.events)).toEqual([
          'initialize:start:A',
          'construct:start:A',
          'construct:end:A:ok',
          'initialize:end:A:ok',
        ]);
        for (const event of events.events) {
          const duration = entriesOf(event).durationMs;
          if (duration !== undefined) expect(duration).toBeGreaterThanOrEqual(0);
        }
        // The container is initialized: a later initialize and a resolve build nothing and say nothing.
        await run.start().promise;
        call(run.box, 'resolve', run.token('A'));
        expect(events.events).toHaveLength(4);
        await call(run.box, 'destroy');
        expect(trace(run, ['A'], events.events).slice(4)).toEqual(['dispose:start:A', 'dispose:end:A:ok']);
        expectBalanced(events.events);
      });
    });

    it(`O3 N=3: each registration has one start and one end per phase while the three factories run at once (${label(cell)})`, async () => {
      await withRun(cell, independent(['A', 'B', 'C']), { observation: true, concurrency: 3 }, async (run) => {
        run.ctl.hold('A', 'B', 'C');
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        const started = run.start();
        await run.settle();
        const running = snapshotOf(run.box);
        expect(inFlightOf(running)).toEqual({ construct: 3, initialize: 3, dispose: 0 });
        expect(running.constructs).toBe(0);
        run.ctl.openAll();
        await started.promise;
        const ends = trace(run, ['A', 'B', 'C'], events.events).filter((entry) => entry.includes(':end:'));
        expect(ends.sort()).toEqual([
          'construct:end:A:ok',
          'construct:end:B:ok',
          'construct:end:C:ok',
          'initialize:end:A:ok',
          'initialize:end:B:ok',
          'initialize:end:C:ok',
        ]);
        expectBalanced(events.events);
        expect(inFlightOf(snapshotOf(run.box))).toEqual({ construct: 0, initialize: 0, dispose: 0 });
      });
    });
  }

  for (const emitter of ['reference', 'optimized'] as const) {
    it(`O3 a class provider is observed like a factory, a transient at each resolve, a value not at all, a class with dispose() when it is destroyed (${emitter})`, async () => {
      const source = `${HEAD_22}
export class Svc { readonly n = 1; }
export class Tr { readonly n = 2; }
export class Closing { dispose(): void {} }
interface IVal { v: number }
const val = useInterface<IVal>();
export const box = defineBuilderConfig({
  name: 'F22Classes',
  injections: [
    { token: Svc },
    { token: Tr, lifecycle: 'transient' },
    { token: Closing },
    { token: val, useValue: { v: 3 } },
  ],
});
`;
      const built = build(source, { emitter, observation: true });
      try {
        const box = built.box();
        const events = recorder();
        subscribe(box, events.sink, countingClock().now);
        call(box, 'resolve', built.exports.Svc);
        call(box, 'resolve', built.exports.Svc);
        call(box, 'resolve', built.exports.Tr);
        call(box, 'resolve', built.exports.Tr);
        call(box, 'resolve', built.exports.Closing);
        call(box, 'resolve', built.id('IVal'));
        await call(box, 'destroy');
        const names = new Map([[built.id('Svc'), 'Svc'], [built.id('Tr'), 'Tr'], [built.id('Closing'), 'Closing']]);
        const seen = events.events.map((event) => `${String(entriesOf(event).phase)}:${String(entriesOf(event).kind)}:${names.get(String(entriesOf(event).registrationId)) ?? 'other'}`);
        expect(seen).toEqual([
          'construct:start:Svc',
          'construct:end:Svc',
          'construct:start:Tr',
          'construct:end:Tr',
          'construct:start:Tr',
          'construct:end:Tr',
          'construct:start:Closing',
          'construct:end:Closing',
          'dispose:start:Closing',
          'dispose:end:Closing',
        ]);
      } finally {
        await built.close();
      }
    });

    it(`O4 a class constructor that throws ends with an error and the error is the application's own (${emitter})`, async () => {
      const source = `${HEAD_22}
export class Bad { constructor() { throw probe.fail; } }
export const box = defineBuilderConfig({ name: 'F22Bad', injections: [{ token: Bad }] });
`;
      const built = build(source, { emitter, observation: true });
      try {
        built.probe.fail = FACTORY_ERROR;
        const box = built.box();
        const events = recorder();
        subscribe(box, events.sink, countingClock().now);
        expect(thrown(() => call(box, 'resolve', built.exports.Bad))).toBe(FACTORY_ERROR);
        expect(events.events.map((event) => `${String(entriesOf(event).kind)}:${String(entriesOf(event).outcome)}`)).toEqual(['start:undefined', 'end:error']);
        expect(snapshotOf(box).failures).toBe(1);
        expect(snapshotOf(box).constructs).toBe(0);
      } finally {
        await built.close();
      }
    });
  }
});

describe('F22 failures: the end is an error, with a recognised NEO code only, never a message or a stack', () => {
  for (const cell of MATRIX) {
    it(`O4 a sync factory that throws: end error, the code only when it is a NEO_* code, nothing of the error or the value (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        const cases: ReadonlyArray<{ error: Error; code: string | undefined }> = [
          { error: FACTORY_ERROR, code: undefined },
          { error: Object.assign(new Error('with a code'), { code: 'NEO_SOMETHING_WRONG' }), code: 'NEO_SOMETHING_WRONG' },
          { error: Object.assign(new Error('lower'), { code: 'neo_something' }), code: undefined },
          { error: Object.assign(new Error('spaces'), { code: 'NEO_HAS SPACE' }), code: undefined },
          { error: Object.assign(new Error('number'), { code: 5 }), code: undefined },
          { error: Object.assign(new Error('node'), { code: 'ENOENT' }), code: undefined },
        ];
        for (const item of cases) {
          events.events.length = 0;
          run.ctl.failWith('A', item.error);
          const caught = thrown(() => call(run.box, 'resolve', run.token('A')));
          // The application error is the factory's own error, as it is.
          expect(caught).toBe(item.error);
          expect(events.events).toHaveLength(2);
          const end = entriesOf(events.events[1]);
          expect(end.kind).toBe('end');
          expect(end.outcome).toBe('error');
          expect(end.errorCode).toBe(item.code);
          expect(keysOf(events.events[1])).toEqual(item.code === undefined ? END_KEYS : [...END_KEYS, 'errorCode'].sort());
          const text = JSON.stringify(events.events);
          expect(text).not.toContain(item.error.message);
          expect(text).not.toContain('stack');
        }
      });
    });

    it(`O4 an error whose code throws when it is read still ends the operation and is rethrown unchanged (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        const hostile = new Error('hostile');
        Object.defineProperty(hostile, 'code', {
          get() {
            throw new Error('code getter');
          },
        });
        run.ctl.failWith('A', hostile);
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        expect(thrown(() => call(run.box, 'resolve', run.token('A')))).toBe(hostile);
        expect(events.events).toHaveLength(2);
        expect(entriesOf(events.events[1]).outcome).toBe('error');
        expect(entriesOf(events.events[1]).errorCode).toBeUndefined();
      });
    });

    it(`O4 an async factory that rejects: both ends are errors at the real settlement, initialize rejects with the factory error (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A' }, { name: 'B' }], { observation: true }, async (run) => {
        run.ctl.hold('B');
        run.ctl.failWith('B', FACTORY_ERROR);
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        const started = run.start();
        await run.settle();
        expect(trace(run, ['A', 'B'], events.events)).toEqual([
          'initialize:start:A',
          'construct:start:A',
          'construct:end:A:ok',
          'initialize:end:A:ok',
          'initialize:start:B',
          'construct:start:B',
        ]);
        run.ctl.open('B');
        const settled = await started.settled;
        expect(settled.error).toBe(FACTORY_ERROR);
        expect(trace(run, ['A', 'B'], events.events).slice(6)).toEqual(['construct:end:B:error', 'initialize:end:B:error']);
        expect(JSON.stringify(events.events)).not.toContain(FACTORY_ERROR.message);
        expectBalanced(events.events);
      });
    });

    it(`O4 a disposer that throws: the dispose ends with an error, destroy still rejects with the disposal failure (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync', dispose: true }, { name: 'B', kind: 'sync', dispose: true }], { observation: true }, async (run) => {
        call(run.box, 'resolve', run.token('A'));
        call(run.box, 'resolve', run.token('B'));
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        run.ctl.failDisposeWith('A', DISPOSE_ERROR);
        let failure: unknown;
        try {
          await call(run.box, 'destroy');
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure instanceof AggregateError ? failure.errors : []).toEqual([DISPOSE_ERROR]);
        const ends = trace(run, ['A', 'B'], events.events).filter((entry) => entry.includes(':end:'));
        expect(ends.sort()).toEqual(['dispose:end:A:error', 'dispose:end:B:ok']);
        expect(JSON.stringify(events.events)).not.toContain(DISPOSE_ERROR.message);
        expect(snapshotOf(run.box)).toMatchObject({ failures: 1, disposes: 1 });
        expectBalanced(events.events);
      });
    });
  }
});

describe('F22 a defective observer does not change the service', () => {
  for (const cell of MATRIX) {
    it(`O5 a sink that throws, rejects or has a thenable that throws: results and errors are unchanged, no unhandled rejection (${label(cell)})`, async () => {
      await withoutUnhandled(async () => {
        await withRun(cell, [{ name: 'A' }, { name: 'B', kind: 'sync', dispose: true }, { name: 'C', kind: 'sync' }], { observation: true }, async (run) => {
          const good = recorder();
          const throwing: Sink = () => {
            throw new Error('sink failure');
          };
          const rejecting: Sink = () => Promise.reject(new Error('sink rejection'));
          const poisoned: Sink = () =>
            // A value whose `then` throws when it is read: the container must not let that escape.
            new Proxy({}, {
              get(_target, key): unknown {
                if (key === 'then') throw new Error('then getter');
                return undefined;
              },
            });
          subscribe(run.box, throwing, countingClock().now);
          subscribe(run.box, rejecting, countingClock().now);
          subscribe(run.box, poisoned, countingClock().now);
          subscribe(run.box, good.sink, countingClock().now);
          await run.start().promise;
          const first = call(run.box, 'resolve', run.token('B'));
          expect(call(run.box, 'resolve', run.token('B'))).toBe(first);
          run.ctl.failWith('C', FACTORY_ERROR);
          // The application error is the factory's, even though every sink fails.
          expect(thrown(() => call(run.box, 'resolve', run.token('C')))).toBe(FACTORY_ERROR);
          await call(run.box, 'destroy');
          // The observers after the defective ones still got every event.
          expect(good.events).toHaveLength(10);
          expectBalanced(good.events);
        });
      });
    });
  }
});

describe('F22 the event is exactly the declared scalars', () => {
  for (const cell of MATRIX) {
    it(`O6 start and end events carry the exact key set, are frozen, hold no object, and a sink cannot alter the next event (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const meddling: Sink = (event) => {
          // A sink that tries to add a property or replace one: the event is frozen, and the next sink sees it as it was.
          if (typeof event !== 'object' || event === null) return;
          Reflect.set(event, 'extra', 'leak');
          Reflect.set(event, 'phase', 'dispose');
          Reflect.defineProperty(event, 'value', { value: 1 });
        };
        const events = recorder();
        subscribe(run.box, meddling, countingClock().now);
        subscribe(run.box, events.sink, countingClock().now);
        run.ctl.failWith('B', Object.assign(new Error('x'), { code: 'NEO_B_FAILED' }));
        call(run.box, 'resolve', run.token('A'));
        thrown(() => call(run.box, 'resolve', run.token('B')));
        expect(events.events).toHaveLength(4);
        const [startA, endA, startB, endB] = events.events;
        expect(keysOf(startA)).toEqual(EVENT_KEYS);
        expect(keysOf(startB)).toEqual(EVENT_KEYS);
        expect(keysOf(endA)).toEqual(END_KEYS);
        expect(keysOf(endB)).toEqual([...END_KEYS, 'errorCode'].sort());
        for (const event of events.events) {
          expect(Object.isFrozen(event)).toBe(true);
          expect(entriesOf(event).phase).toBe('construct');
          for (const value of Object.values(entriesOf(event))) expect(['string', 'number']).toContain(typeof value);
          expect(JSON.stringify(event)).not.toContain('/virtual');
        }
        expect(entriesOf(startA).kind).toBe('start');
        expect(entriesOf(endA).outcome).toBe('ok');
        expect(entriesOf(endB).errorCode).toBe('NEO_B_FAILED');
      });
    });
  }
});

describe('F22 the snapshot', () => {
  for (const cell of MATRIX) {
    it(`O7 after a successful initialize, scopes created and destroyed, and a destroy: scalars only, counters right (${label(cell)})`, async () => {
      await withRun(cell, independent(['A', 'B']), { observation: true }, async (run) => {
        const created = snapshotOf(run.box);
        expect(Object.keys(created).sort()).toEqual(SNAPSHOT_KEYS);
        expect(created.state).toBe('created');
        expect(created).toMatchObject({ constructs: 0, initializes: 0, disposes: 0, failures: 0, cancellations: 0, activeScopes: 0 });
        run.ctl.hold('A', 'B');
        const started = run.start();
        await run.settle();
        const running = snapshotOf(run.box);
        expect(running.state).toBe('initializing');
        expect(inFlightOf(running)).toEqual({ construct: 1, initialize: 1, dispose: 0 });
        run.ctl.openAll();
        await started.promise;
        const ready = snapshotOf(run.box);
        expect(ready).toEqual({
          state: 'ready',
          constructs: 2,
          initializes: 2,
          disposes: 0,
          failures: 0,
          cancellations: 0,
          inFlight: { construct: 0, initialize: 0, dispose: 0 },
          activeScopes: 0,
        });
        // The snapshot holds no reference: it survives a JSON round trip unchanged, and a second one is another object.
        expect(JSON.parse(JSON.stringify(ready))).toEqual(ready);
        expect(snapshotOf(run.box)).not.toBe(ready);
        const first = objectOf(call(run.box, 'createScope'));
        const second = objectOf(call(run.box, 'createScope'));
        expect(snapshotOf(run.box).activeScopes).toBe(2);
        // The scopes and their parent share the counters.
        expect(snapshotOf(first).activeScopes).toBe(2);
        await call(first, 'destroy');
        expect(snapshotOf(run.box).activeScopes).toBe(1);
        await call(first, 'destroy');
        expect(snapshotOf(run.box).activeScopes).toBe(1);
        await call(second, 'destroy');
        expect(snapshotOf(run.box).activeScopes).toBe(0);
        await call(run.box, 'destroy');
        const closed = snapshotOf(run.box);
        expect(closed.state).toBe('destroyed');
        expect(closed.disposes).toBe(2);
        expect(inFlightOf(closed)).toEqual({ construct: 0, initialize: 0, dispose: 0 });
      });
    });

    it(`O7 after a failed initialize: the failure is counted, what was built is rolled back, the state is failed (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', dispose: true }, { name: 'B' }], { observation: true }, async (run) => {
        run.ctl.failWith('B', FACTORY_ERROR);
        const settled = await run.start().settled;
        expect(settled.error).toBe(FACTORY_ERROR);
        const failed = snapshotOf(run.box);
        expect(failed.state).toBe('failed');
        expect(failed.constructs).toBe(1);
        expect(failed.initializes).toBe(1);
        // The construct of B and its initialize step both ended with the error.
        expect(failed.failures).toBe(2);
        // A was built, and the rollback of the failed initialization closed it.
        expect(failed.disposes).toBe(1);
        expect(run.ctl.disposed.get('A')).toBe(1);
        expect(inFlightOf(failed)).toEqual({ construct: 0, initialize: 0, dispose: 0 });
      });
    });

    it(`O7 after an initialize cancelled with a signal: the cancellation is counted at the abort, the late value settles and is closed (${label(cell)})`, async () => {
      await withoutUnhandled(async () => {
        await withRun(cell, independent(['A']), { observation: true }, async (run) => {
          run.ctl.hold('A');
          const controller = new AbortController();
          const started = run.start({ signal: controller.signal });
          await run.settle();
          expect(snapshotOf(run.box).cancellations).toBe(0);
          controller.abort(REASON);
          await run.settle();
          const cancelling = snapshotOf(run.box);
          expect(cancelling.cancellations).toBe(1);
          expect(cancelling.state).toBe('cancelling');
          expect(inFlightOf(cancelling)).toEqual({ construct: 1, initialize: 1, dispose: 0 });
          run.ctl.openAll();
          const settled = await started.settled;
          expect(settled.error).toBe(REASON);
          await run.settle();
          await run.settle();
          const cancelled = snapshotOf(run.box);
          expect(cancelled.state).toBe('failed');
          expect(cancelled.cancellations).toBe(1);
          expect(cancelled.constructs).toBe(1);
          expect(cancelled.disposes).toBe(1);
          expect(inFlightOf(cancelled)).toEqual({ construct: 0, initialize: 0, dispose: 0 });
        });
      });
    });

    it(`O7 a sync container is ready at once, counts what it builds and ends destroyed (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync', dispose: true }], { observation: true }, async (run) => {
        expect(snapshotOf(run.box).state).toBe('ready');
        call(run.box, 'resolve', run.token('A'));
        expect(snapshotOf(run.box)).toMatchObject({ constructs: 1, initializes: 0, disposes: 0 });
        await call(run.box, 'destroy');
        expect(snapshotOf(run.box)).toMatchObject({ state: 'destroyed', constructs: 1, disposes: 1 });
      });
    });
  }
});

/** A `gc()` that needs no `--expose-gc`: the flag is turned on, and the function read from a fresh context. */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  const collect: unknown = runInNewContext('gc');
  if (typeof collect !== 'function') throw new Error('no gc');
  return () => {
    Reflect.apply(collect, undefined, []);
  };
}

describe('F22 unsubscribe', () => {
  for (const cell of MATRIX) {
    it(`O8 after unsubscribe no event is delivered, a second call is harmless, the other subscriber keeps its events (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const leaving = recorder();
        const staying = recorder();
        const stop = subscribe(run.box, leaving.sink, countingClock().now);
        subscribe(run.box, staying.sink, countingClock().now);
        call(run.box, 'resolve', run.token('A'));
        expect(leaving.events).toHaveLength(2);
        stop();
        stop();
        call(run.box, 'resolve', run.token('B'));
        expect(leaving.events).toHaveLength(2);
        expect(staying.events).toHaveLength(4);
      });
    });

    it(`O8 an operation that began before the unsubscribe ends without telling the sink (${label(cell)})`, async () => {
      await withRun(cell, independent(['A']), { observation: true }, async (run) => {
        run.ctl.hold('A');
        const events = recorder();
        const stop = subscribe(run.box, events.sink, countingClock().now);
        const started = run.start();
        await run.settle();
        expect(events.events).toHaveLength(2);
        stop();
        run.ctl.open('A');
        await started.promise;
        expect(events.events).toHaveLength(2);
        expect(snapshotOf(run.box).constructs).toBe(1);
      });
    });

    it(`O8 after unsubscribe the container no longer holds the sink: it is collected (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        let sink: Sink | undefined = recorder().sink;
        const reference = new WeakRef(sink);
        const stop = subscribe(run.box, sink, countingClock().now);
        call(run.box, 'resolve', run.token('A'));
        stop();
        sink = undefined;
        for (let attempt = 0; attempt < 5 && reference.deref() !== undefined; attempt += 1) {
          await tick();
          collect();
        }
        expect(reference.deref()).toBeUndefined();
        call(run.box, 'resolve', run.token('B'));
      });
    });
  }
});

describe('F22 the profiles keep their promises', () => {
  for (const cell of MATRIX) {
    it(`O9 full keeps on('resolve'), minimal has neither on nor override, both have observe and stateSnapshot (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        expect(typeof Reflect.get(run.box, 'observe')).toBe('function');
        expect(typeof Reflect.get(run.box, 'stateSnapshot')).toBe('function');
        if (cell.profile === 'full') {
          const resolved: unknown[] = [];
          const stop = call(run.box, 'on', 'resolve', (token: unknown) => resolved.push(token));
          expect(typeof stop).toBe('function');
          call(run.box, 'resolve', run.token('A'));
          expect(resolved).toEqual([run.token('A')]);
        } else if (cell.emitter === 'optimized') {
          // The reference emitter is the witness of the full surface and writes `on` for every profile.
          expect(Reflect.get(run.box, 'on')).toBeUndefined();
          expect(Reflect.get(run.box, 'override')).toBeUndefined();
          expect(Reflect.get(run.box, 'clearOverrides')).toBeUndefined();
        }
      });
    });
  }
});

describe('F22 ids are the ids of the build artifact', () => {
  for (const cell of MATRIX) {
    it(`O10 registrationId is the token id of the graph, multi contributions are multi:<id>:<index>, there is one container id (${label(cell)})`, async () => {
      const specs: Spec[] = [
        { name: 'A', kind: 'sync' },
        { name: 'B' },
        { name: 'M', part: 'M0' },
        { name: 'M', part: 'M1', kind: 'sync' },
      ];
      await withRun(cell, specs, { observation: true }, async (run) => {
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        await run.start().promise;
        call(run.box, 'resolve', run.token('A'));
        call(run.box, 'resolve', run.token('B'));
        call(run.box, 'resolveAll', run.token('M'));
        const ids = new Set(events.events.map((event) => entriesOf(event).registrationId));
        expect(ids).toEqual(new Set([run.token('A'), run.token('B'), `multi:${run.token('M')}:0`, `multi:${run.token('M')}:1`]));
        // Every id the events carry is a key of the graph the build read.
        for (const id of ids) {
          const text = String(id);
          const key = text.startsWith('multi:') ? text.slice('multi:'.length, text.lastIndexOf(':')) : text;
          expect([...run.graph.nodes.keys(), ...(run.graph.multiNodes?.keys() ?? [])]).toContain(key);
        }
        const containers = new Set(events.events.map((event) => entriesOf(event).containerId));
        expect(containers.size).toBe(1);
        expect([...containers][0]).toMatch(/^[A-Za-z0-9_-]+$/);
        const roots = new Set(events.events.map((event) => entriesOf(event).scopeId));
        expect(roots).toEqual(new Set(['root']));
        expectBalanced(events.events);
      });
    });
  }
});

describe('F22 scopes report under ids of their own', () => {
  for (const cell of MATRIX) {
    it(`O10 a scope has its own scope id and its container's id, two scopes have two ids, none is the root (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        call(run.box, 'resolve', run.token('A'));
        const scope = objectOf(call(run.box, 'createScope'));
        const other = objectOf(call(run.box, 'createScope'));
        call(scope, 'resolve', run.token('A'));
        call(other, 'resolve', run.token('A'));
        expect(events.events).toHaveLength(6);
        const ids = events.events.map((event) => entriesOf(event).scopeId);
        expect(ids.slice(0, 2)).toEqual(['root', 'root']);
        expect(ids[2]).toBe(ids[3]);
        expect(ids[4]).toBe(ids[5]);
        expect(new Set(ids).size).toBe(3);
        const containers = new Set(events.events.map((event) => entriesOf(event).containerId));
        expect(containers.size).toBe(1);
        expect([...containers][0]).toMatch(/^[A-Za-z0-9_-]+$/);
        expectBalanced(events.events);
      });
    });
  }
});

describe('F22 scopes with inputs', () => {
  for (const cell of INPUT_CELLS) {
    it(`O7 a scope that takes inputs is counted while it lives, reports under its own scope id, and leaves the count at destroy (${inputLabel(cell)})`, async () => {
      await withEnv(cell, { observation: true }, async (env) => {
        const events = recorder();
        subscribe(env.box, events.sink, countingClock().now);
        expect(snapshotOf(env.box).activeScopes).toBe(0);
        const scope = env.scope();
        expect(snapshotOf(env.box).activeScopes).toBe(1);
        expect(snapshotOf(scope).activeScopes).toBe(1);
        await call(scope, 'initialize');
        call(scope, 'resolve', env.built.id('Svc'));
        expect(events.events.length).toBeGreaterThan(0);
        const scopeIds = new Set(events.events.map((event) => entriesOf(event).scopeId));
        expect(scopeIds.size).toBe(1);
        expect(scopeIds.has('root')).toBe(false);
        expectBalanced(events.events);
        await call(scope, 'destroy');
        expect(snapshotOf(env.box).activeScopes).toBe(0);
        expect(snapshotOf(scope).state).toBe('destroyed');
      });
    });
  }
});

describe('F22 the trace adapter on a container', () => {
  for (const cell of MATRIX.filter((item) => item.mode === 'open')) {
    it(`O11 observationChannel(channel) as the sink: the events reach a diagnostics_channel subscriber and the service is unchanged (${label(cell)})`, async () => {
      expect(typeof neosyringe.observationChannel, 'observationChannel is exported').toBe('function');
      const name = `neosyringe:f22:${label(cell)}`;
      const channel = diagnosticsChannel.channel(name);
      const received: unknown[] = [];
      const listener = (message: unknown): void => {
        received.push(message);
      };
      diagnosticsChannel.subscribe(name, listener);
      try {
        await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
          const stop = subscribe(run.box, neosyringe.observationChannel(channel), countingClock().now);
          const value = call(run.box, 'resolve', run.token('A'));
          expect(entriesOf(value).name).toBe('A');
          expect(received.map((message) => entriesOf(message).kind)).toEqual(['start', 'end']);
          expect(keysOf(received[1])).toEqual(END_KEYS);
          stop();
          call(run.box, 'resolve', run.token('B'));
          expect(received).toHaveLength(2);
        });
      } finally {
        diagnosticsChannel.unsubscribe(name, listener);
      }
    });
  }
});

/** Runs the collector until `reference` is empty, or five turns have passed. */
async function untilCollected(reference: WeakRef<object>, collect: () => void): Promise<void> {
  for (let attempt = 0; attempt < 5 && reference.deref() !== undefined; attempt += 1) {
    await tick();
    collect();
  }
}

/** A recording sink subscribed to `box`; the test keeps its events and a weak reference, never the sink itself. */
function subscribeWeak(box: object): { events: object[]; reference: WeakRef<object>; stop: () => void } {
  const events: object[] = [];
  const sink: Sink = (event) => {
    if (typeof event === 'object' && event !== null) events.push(event);
  };
  const stop = subscribe(box, sink, countingClock().now);
  return { events, reference: new WeakRef(sink), stop };
}

describe('F22 a sink is released when the container or the scope that took it is destroyed', () => {
  for (const cell of MATRIX) {
    it(`O13 a sink subscribed through a scope sees the container tree, then gets no event and is collected once the scope is destroyed (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const scope = objectOf(call(run.box, 'createScope'));
        const rootSink = recorder();
        subscribe(run.box, rootSink.sink, countingClock().now);
        const scoped = subscribeWeak(scope);
        // The sink of the scope is one more subscriber of the whole container: it also sees the events of the root.
        call(run.box, 'resolve', run.token('A'));
        expect(scoped.events).toHaveLength(2);
        expect(new Set(scoped.events.map((event) => entriesOf(event).scopeId))).toEqual(new Set(['root']));
        await call(scope, 'destroy');
        call(run.box, 'resolve', run.token('B'));
        // The destroyed scope let go of its sink: nothing more reaches it, and the sink of the root is untouched.
        expect(scoped.events).toHaveLength(2);
        expect(rootSink.events).toHaveLength(4);
        await untilCollected(scoped.reference, collect);
        expect(scoped.reference.deref()).toBeUndefined();
      });
    });

    it(`O13 a sink subscribed after the scope is destroyed holds nothing: unsubscribing is harmless and the sink is collected (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        const scope = objectOf(call(run.box, 'createScope'));
        await call(scope, 'destroy');
        const late = subscribeWeak(scope);
        call(run.box, 'resolve', run.token('A'));
        expect(late.events).toHaveLength(0);
        await untilCollected(late.reference, collect);
        expect(late.reference.deref()).toBeUndefined();
        late.stop();
      });
    });

    it(`O13 after the container is destroyed its sink is collected once its dispose events reached it, and a scope keeps its own sink until the scope is destroyed (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, [{ name: 'A', kind: 'sync', dispose: true }], { observation: true }, async (run) => {
        const scope = objectOf(call(run.box, 'createScope'));
        const scoped = subscribeWeak(scope);
        const root = subscribeWeak(run.box);
        call(run.box, 'resolve', run.token('A'));
        await call(run.box, 'destroy');
        // The disposal of the destroy is observed first, then the container lets go of its sinks.
        expect(root.events.map((event) => `${String(entriesOf(event).phase)}:${String(entriesOf(event).kind)}`)).toEqual([
          'construct:start',
          'construct:end',
          'dispose:start',
          'dispose:end',
        ]);
        await untilCollected(root.reference, collect);
        expect(root.reference.deref()).toBeUndefined();
        // The sink taken through the scope is the scope's: the destroy of the container does not release it.
        collect();
        expect(scoped.reference.deref()).toBeDefined();
        await call(scope, 'destroy');
        await untilCollected(scoped.reference, collect);
        expect(scoped.reference.deref()).toBeUndefined();
      });
    });

    it(`O13 on a container with async work, a destroy after initialize lets go of the sink once its dispose events reached it (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, independent(['A']), { observation: true }, async (run) => {
        await run.start().promise;
        const root = subscribeWeak(run.box);
        await call(run.box, 'destroy');
        expect(root.events.map((event) => `${String(entriesOf(event).phase)}:${String(entriesOf(event).kind)}`)).toEqual(['dispose:start', 'dispose:end']);
        await untilCollected(root.reference, collect);
        expect(root.reference.deref()).toBeUndefined();
      });
    });

    it(`O13 on a container with async work, a destroy before initialize lets go of the sink too (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, independent(['A']), { observation: true }, async (run) => {
        const root = subscribeWeak(run.box);
        await call(run.box, 'destroy');
        await untilCollected(root.reference, collect);
        expect(root.reference.deref()).toBeUndefined();
      });
    });

    it(`O13 a sink subscribed after the container is destroyed holds nothing (${label(cell)})`, async () => {
      const collect = collector();
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        await call(run.box, 'destroy');
        const late = subscribeWeak(run.box);
        await untilCollected(late.reference, collect);
        expect(late.reference.deref()).toBeUndefined();
        late.stop();
      });
    });
  }
});

describe('F22 the dispose events of a rollback carry the id of the registration they close', () => {
  for (const cell of MATRIX) {
    it(`O7 a failed initialize rolls back a singleton and a multi contribution: each dispose start and end carries its registration id (${label(cell)})`, async () => {
      const specs: Spec[] = [
        { name: 'A', dispose: true },
        { name: 'M', part: 'M0', dispose: true },
        { name: 'B', deps: ['A', '*M'] },
      ];
      await withRun(cell, specs, { observation: true }, async (run) => {
        run.ctl.failWith('B', FACTORY_ERROR);
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        expect((await run.start().settled).error).toBe(FACTORY_ERROR);
        const closing = events.events
          .filter((event) => entriesOf(event).phase === 'dispose')
          .map((event) => `${String(entriesOf(event).kind)}:${String(entriesOf(event).registrationId)}:${String(entriesOf(event).outcome)}`);
        const multi = `multi:${run.token('M')}:0`;
        const a = run.token('A');
        // The rollback closes the values in the reverse order of the journal, and every event says which registration it is.
        expect(closing.slice().sort()).toEqual([`end:${a}:ok`, `end:${multi}:ok`, `start:${a}:undefined`, `start:${multi}:undefined`].sort());
        expect(run.ctl.disposed.get('A')).toBe(1);
        expect(run.ctl.disposed.get('M0')).toBe(1);
        expectBalanced(events.events);
      });
    });
  }
});

describe('F22 a disposer whose result cannot be read', () => {
  for (const emitter of ['reference', 'optimized'] as const) {
    it(`O4 a disposer that returns a value whose then getter throws: the dispose ends with an error, nothing stays in flight, destroy rejects with that error (${emitter})`, async () => {
      const source = `${HEAD_22}
export class Hostile { dispose(): object { return { get then(): never { throw probe.fail; } }; } }
export const box = defineBuilderConfig({ name: 'F22Hostile', injections: [{ token: Hostile }] });
`;
      const built = build(source, { emitter, observation: true });
      try {
        built.probe.fail = DISPOSE_ERROR;
        const box = built.box();
        const events = recorder();
        subscribe(box, events.sink, countingClock().now);
        call(box, 'resolve', built.exports.Hostile);
        let failure: unknown;
        try {
          await call(box, 'destroy');
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure instanceof AggregateError ? failure.errors : []).toEqual([DISPOSE_ERROR]);
        const closing = events.events.filter((event) => entriesOf(event).phase === 'dispose');
        expect(closing.map((event) => `${String(entriesOf(event).kind)}:${String(entriesOf(event).outcome)}`)).toEqual(['start:undefined', 'end:error']);
        expect(inFlightOf(snapshotOf(box))).toEqual({ construct: 0, initialize: 0, dispose: 0 });
        expect(snapshotOf(box).failures).toBe(1);
      } finally {
        await built.close();
      }
    });
  }
});

/** A clock that answers `reads` in order: a number, `'throw'` or `NaN`; after the last it answers the last number again. */
function scriptedClock(reads: ReadonlyArray<number | 'throw'>): () => number {
  let at = 0;
  return () => {
    const read = reads[Math.min(at, reads.length - 1)];
    at += 1;
    if (read === 'throw' || read === undefined) throw new Error('clock failure');
    return read;
  };
}

describe('F22 a clock that fails does not change the service, and an end is never lost', () => {
  for (const cell of MATRIX) {
    it(`O14 a clock that throws or answers NaN at the start: no event for that sink, the service is unchanged, the other sink keeps its events (${cell.emitter}/${cell.profile}/${cell.mode})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const broken = recorder();
        const nan = recorder();
        const good = recorder();
        subscribe(run.box, broken.sink, scriptedClock(['throw']));
        subscribe(run.box, nan.sink, scriptedClock([Number.NaN]));
        subscribe(run.box, good.sink, countingClock().now);
        const value = call(run.box, 'resolve', run.token('A'));
        expect(entriesOf(value).name).toBe('A');
        expect(broken.events).toHaveLength(0);
        expect(nan.events).toHaveLength(0);
        expect(good.events).toHaveLength(2);
        expect(snapshotOf(run.box).constructs).toBe(1);
        call(run.box, 'resolve', run.token('B'));
        expect(good.events).toHaveLength(4);
      });
    });

    it(`O14 a clock that throws or answers NaN at the end: the end is still published, without durationMs, and the other sink gets its duration (${cell.emitter}/${cell.profile}/${cell.mode})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }, { name: 'B', kind: 'sync' }], { observation: true }, async (run) => {
        const thrower = recorder();
        const nan = recorder();
        const good = recorder();
        subscribe(run.box, thrower.sink, scriptedClock([1, 'throw']));
        subscribe(run.box, nan.sink, scriptedClock([1, Number.NaN]));
        subscribe(run.box, good.sink, countingClock().now);
        call(run.box, 'resolve', run.token('A'));
        for (const sink of [thrower, nan]) {
          expect(sink.events.map((event) => entriesOf(event).kind)).toEqual(['start', 'end']);
          expect(keysOf(sink.events[1])).toEqual(['containerId', 'kind', 'outcome', 'phase', 'registrationId', 'scopeId']);
          expect(entriesOf(sink.events[1]).outcome).toBe('ok');
          expectBalanced(sink.events);
        }
        expect(keysOf(good.events[1])).toEqual(END_KEYS);
        expect(snapshotOf(run.box)).toMatchObject({ constructs: 1, failures: 0 });
      });
    });

    it(`O14 observe() refuses what is not a function, and nothing is subscribed (${cell.emitter}/${cell.profile}/${cell.mode})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync' }], { observation: true }, async (run) => {
        for (const bad of [42, 'sink', null, {}]) {
          const error = thrown(() => call(run.box, 'observe', bad, undefined));
          expect(error).toBeInstanceOf(Error);
          expect(String(Reflect.get(objectOf(error), 'message'))).toContain('observe() needs a function');
        }
        const events = recorder();
        subscribe(run.box, events.sink, countingClock().now);
        call(run.box, 'resolve', run.token('A'));
        expect(events.events).toHaveLength(2);
      });
    });
  }
});

describe('F22 the snapshot of a sync container reports its states', () => {
  for (const cell of MATRIX) {
    it(`O7 a sync container is destroying while a disposer is pending, then destroyed (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync', disposeGate: true }], { observation: true }, async (run) => {
        run.ctl.hold('A:dispose');
        call(run.box, 'resolve', run.token('A'));
        expect(snapshotOf(run.box).state).toBe('ready');
        const closing = Promise.resolve(call(run.box, 'destroy'));
        await run.settle();
        const during = snapshotOf(run.box);
        expect(during.state).toBe('destroying');
        expect(inFlightOf(during).dispose).toBe(1);
        run.ctl.openAll();
        await closing;
        expect(snapshotOf(run.box)).toMatchObject({ state: 'destroyed', disposes: 1 });
      });
    });
  }

  for (const cell of MATRIX.filter((item) => item.profile === 'full')) {
    it(`O7 a sync container is reconfiguring while an override waits for a disposer, and failed after an override that failed (${label(cell)})`, async () => {
      await withRun(cell, [{ name: 'A', kind: 'sync', disposeGate: true }], { observation: true, testOverrides: true }, async (run) => {
        run.ctl.hold('A:dispose');
        call(run.box, 'resolve', run.token('A'));
        const pending = Promise.resolve(call(run.box, 'override', run.token('A'), () => ({ name: 'mock' })));
        await run.settle();
        expect(snapshotOf(run.box).state).toBe('reconfiguring');
        run.ctl.openAll();
        await pending;
        expect(snapshotOf(run.box).state).toBe('ready');
        // The mock replaced A; clear it, then fail the disposal of a fresh A.
        await call(run.box, 'clearOverrides');
        call(run.box, 'resolve', run.token('A'));
        run.ctl.failDisposeWith('A', DISPOSE_ERROR);
        const failed = await Promise.resolve(call(run.box, 'override', run.token('A'), () => ({ name: 'mock' }))).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failed).toBeInstanceOf(AggregateError);
        expect(snapshotOf(run.box).state).toBe('failed');
      });
    });
  }
});
