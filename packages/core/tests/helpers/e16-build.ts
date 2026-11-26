import { expect } from 'vitest';
import { EMITTERS, HEAD, build, readKey, type Built, type Emitter } from './e17-build';

/**
 * E16 (topic 16, `overrideMany`) build helper, on top of the E17 one. Every call goes through `Reflect` on `unknown`:
 * no test types the method it checks. The source of a cell declares three singletons: `PortA` (an async `dispose` that
 * waits for the gate `probe.saved[0]` when a test put one there), `PortB` (a sync `dispose` that throws `probe.fail` when
 * it is set) and `PortC` (nothing to dispose). Each build and each dispose bumps a counter of `probe.counts`.
 */

export { EMITTERS, HEAD, readKey };
export type { Built, Emitter };

export type Mode = 'open' | 'closed';
export type Timing = 'sync' | 'async';

export interface Cell {
  emitter: Emitter;
  mode: Mode;
  timing: Timing;
}

const MODES: readonly Mode[] = ['open', 'closed'];
const TIMINGS: readonly Timing[] = ['sync', 'async'];

/** Both emitters x open and closed x sync and async. */
export const CELLS: readonly Cell[] = EMITTERS.flatMap((emitter) =>
  MODES.flatMap((mode) => TIMINGS.map((timing) => ({ emitter, mode, timing }))),
);

export function label(cell: Cell): string {
  return `${cell.emitter} ${cell.mode} ${cell.timing}`;
}

export interface SourceOptions {
  profile?: 'full' | 'minimal';
  /** Adds the multi token `PortM` (two registrations). */
  multi?: boolean;
}

export function sourceFor(cell: Cell, options: SourceOptions = {}): string {
  const asyncFactory = cell.timing === 'async' ? 'async ' : '';
  const multi = options.multi === true;
  const roots = `portA, portB, portC${multi ? ', { all: portM }' : ''}`;
  const optimization = cell.mode === 'closed' ? `optimization: { mode: 'closed', roots: [${roots}] },` : '';
  return `${HEAD}
const bump = (key: string): void => { probe.counts[key] = (probe.counts[key] ?? 0) + 1; };
interface PortA { n: number; dispose(): Promise<void> }
interface PortB { n: number; dispose(): void }
interface PortC { n: number }
interface PortM { n: number }
const portA = useInterface<PortA>();
const portB = useInterface<PortB>();
const portC = useInterface<PortC>();
const portM = useInterface<PortM>();
export const box = defineBuilderConfig({
  name: 'E16',
  runtime: { profile: '${options.profile ?? 'full'}' },
  ${optimization}
  injections: [
    { token: portA, useFactory: true, dependencies: [], provider: ${asyncFactory}() => { bump('buildA'); return { n: 1, async dispose() { bump('disposeA'); await probe.saved[0]; } }; } },
    { token: portB, useFactory: true, dependencies: [], provider: ${asyncFactory}() => { bump('buildB'); return { n: 2, dispose() { bump('disposeB'); if (probe.fail !== undefined) throw probe.fail; } }; } },
    { token: portC, useFactory: true, dependencies: [], provider: ${asyncFactory}() => { bump('buildC'); return { n: 3 }; } },
    ${multi ? `{ token: portM, multi: true, useFactory: true, dependencies: [], provider: ${asyncFactory}() => ({ n: 4 }) },
    { token: portM, multi: true, useFactory: true, dependencies: [], provider: ${asyncFactory}() => ({ n: 5 }) },` : ''}
  ],
});
`;
}

export interface Env {
  built: Built;
  box: object;
  a: string;
  b: string;
  c: string;
  m: string;
  /** How many times the counter `key` of the source was bumped. */
  count: (key: string) => number;
  /** The gates a test opened on `PortA`: the release opens them all, so a failed test never hangs the destroy. */
  gates: Deferred[];
}

export interface EnvOptions extends SourceOptions {
  testOverrides?: boolean;
  /** Async cells call `initialize()` before the scenario. Default: true. */
  initialize?: boolean;
}

/** Builds one cell, runs `scenario`, and always releases the container. */
export async function withEnv<T>(cell: Cell, options: EnvOptions, scenario: (env: Env) => Promise<T> | T): Promise<T> {
  const built = build(sourceFor(cell, options), { emitter: cell.emitter, testOverrides: options.testOverrides ?? true });
  const gates: Deferred[] = [];
  try {
    const box = built.box();
    if (cell.timing === 'async' && options.initialize !== false) await call(box, 'initialize');
    return await scenario({
      built,
      box,
      a: built.id('PortA'),
      b: built.id('PortB'),
      c: built.id('PortC'),
      m: options.multi === true ? built.id('PortM') : '',
      count: (key) => built.probe.counts[key] ?? 0,
      gates,
    });
  } finally {
    for (const gate of gates) gate.open();
    built.probe.fail = undefined;
    await built.close();
  }
}

/** `box[name](...args)`, called through `Reflect` on `unknown`. */
export function call(box: unknown, name: string, args: readonly unknown[] = []): Promise<unknown> {
  const member: unknown = readKey(box, name);
  if (typeof member !== 'function') throw new Error(`${name} is not a function`);
  const result: unknown = Reflect.apply(member, box, args);
  return Promise.resolve(result);
}

/** Every test of the topic starts here: the method is a function on the container, whatever it then does. */
export function capabilityMany(box: unknown): void {
  expect(typeof readKey(box, 'overrideMany'), 'overrideMany exposed').toBe('function');
}

/** `box.overrideMany(entries)`, called through `Reflect` on `unknown`. The promise is the one the container returned. */
export function overrideMany(box: unknown, entries: unknown): Promise<unknown> {
  capabilityMany(box);
  const member: unknown = readKey(box, 'overrideMany');
  if (typeof member !== 'function') throw new Error('overrideMany is not a function');
  const result: unknown = Reflect.apply(member, box, [entries]);
  if (!(result instanceof Promise)) throw new Error('overrideMany did not return a promise');
  return result;
}

/** `box.resolve(token)`, called through `Reflect` on `unknown`. */
export function resolve(box: unknown, token: unknown): unknown {
  const member: unknown = readKey(box, 'resolve');
  if (typeof member !== 'function') throw new Error('resolve is not a function');
  return Reflect.apply(member, box, [token]);
}

/** The error a promise rejects with, `undefined` when it resolves. */
export async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

export interface Failure {
  code: string;
  message: string;
}

/** The code and message of a rejection, `{ code: '', message: '' }` when the promise resolves. */
export async function failure(work: Promise<unknown>): Promise<Failure> {
  const error = await rejection(work);
  const code = readKey(error, 'code');
  const message = readKey(error, 'message');
  return { code: typeof code === 'string' ? code : '', message: typeof message === 'string' ? message : '' };
}

/** The code and message of what a synchronous call throws, `{ code: '', message: '' }` when it answers. */
export function thrown(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    const code = readKey(error, 'code');
    const message = readKey(error, 'message');
    return { code: typeof code === 'string' ? code : '', message: typeof message === 'string' ? message : '' };
  }
  return { code: '', message: '' };
}

export interface Deferred {
  promise: Promise<void>;
  open: () => void;
}

/** A promise a test settles itself: the dispose of `PortA` waits on it once it is in `probe.saved[0]`. */
export function deferred(): Deferred {
  let open = (): void => {};
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, open };
}

/** Puts a gate on the dispose of `PortA`. */
export function gateA(env: Env): Deferred {
  const gate = deferred();
  env.built.probe.saved[0] = gate.promise;
  env.gates.push(gate);
  return gate;
}

/** A counted mock: a factory and the number of times it was called and disposed. */
export interface Mock {
  readonly factory: () => unknown;
  readonly instance: { readonly id: string; dispose: () => void };
  calls: number;
  disposals: number;
}

export function mockOf(id: string): Mock {
  const mock: Mock = {
    calls: 0,
    disposals: 0,
    instance: {
      id,
      dispose: () => {
        mock.disposals += 1;
      },
    },
    factory: () => {
      mock.calls += 1;
      return mock.instance;
    },
  };
  return mock;
}

export function overridesOf(box: unknown): Map<unknown, unknown> {
  const table = readKey(box, 'overrides');
  if (!(table instanceof Map)) throw new Error('overrides is not a map');
  return table;
}

/** The text of the generated container from `from` to the first of `until` found after it. */
export function slice(text: string, from: string, until: readonly string[]): string {
  const start = text.indexOf(from);
  expect(start, `generated text has ${from}`).toBeGreaterThanOrEqual(0);
  const ends = until.map((marker) => text.indexOf(marker, start + from.length)).filter((index) => index >= 0);
  return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}
