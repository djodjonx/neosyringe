import { expect } from 'vitest';
import type { DependencyGraph } from '../../src/analyzer/types';
import { EMITTERS, HEAD, build, readKey, type Built, type Emitter } from './e17-build';

/**
 * E18 (topic 18, scope inputs) build helper, on top of the E17 one. Every call goes through `Reflect` on `unknown`:
 * no test types the member it checks. The source of a cell declares two inputs, `Req` (an interface token) and
 * `retries` (a property token of `Holder`), and three services that read them:
 * - `Holder` (a class, owned, with `dispose`) reads both inputs in its constructor;
 * - `Svc` (an interface token, a factory) holds a `Holder`;
 * - `Eager` (a class) is only there for closed cells, where it is an `eager` root.
 * The two tokens are also registered with `useValue` in a second container, `E18Ids`, so that their runtime ids exist
 * in the analysis whether or not the container under test knows its inputs.
 */

export { EMITTERS, HEAD, readKey };
export type { Built, Emitter };

export type Mode = 'open' | 'closed';
export type Timing = 'sync' | 'async';
export type Profile = 'full' | 'minimal';

export interface Cell {
  emitter: Emitter;
  mode: Mode;
  timing: Timing;
  profile: Profile;
}

const MODES: readonly Mode[] = ['open', 'closed'];
const TIMINGS: readonly Timing[] = ['sync', 'async'];
const PROFILES: readonly Profile[] = ['full', 'minimal'];

/** Both emitters x open and closed x sync and async, full profile. */
export const CELLS: readonly Cell[] = EMITTERS.flatMap((emitter) =>
  MODES.flatMap((mode) => TIMINGS.map((timing) => ({ emitter, mode, timing, profile: 'full' as const }))),
);

/** The same cells in both profiles. */
export const MATRIX: readonly Cell[] = PROFILES.flatMap((profile) => CELLS.map((cell) => ({ ...cell, profile })));

export function label(cell: Cell): string {
  return `${cell.emitter} ${cell.profile} ${cell.mode} ${cell.timing}`;
}

export interface SourceOptions {
  /** The `scopeInputs` text. Default: `[req, retries]`. */
  inputs?: string;
  /** Extra injections written after the three services. */
  extra?: string;
  /** Text written after the container under test. */
  after?: string;
  /** Text written before the container under test (a parent container, for `useContainer`). */
  before?: string;
  /** The `useContainer` line of the container under test. */
  useContainer?: string;
  /**
   * `Holder` also depends on `Slow`, a class whose async `dispose` waits for the gate `probe.saved[0]`: a
   * reconfiguration or a destroy of the container stays pending until the test opens it.
   */
  slow?: boolean;
}

export function sourceFor(cell: Cell, options: SourceOptions = {}): string {
  const asyncFactory = cell.timing === 'async' ? 'async ' : '';
  const slow = options.slow === true;
  const closed = cell.mode === 'closed'
    ? "optimization: { mode: 'closed', roots: [svc], eager: [Eager] },"
    : '';
  return `${HEAD}
const bump = (key: string): void => { probe.counts[key] = (probe.counts[key] ?? 0) + 1; };
interface Req { id: string; user: string }
interface Twin { id: string; user: string }
interface Svc { holder: Holder }
${slow ? "export class Slow { async dispose(): Promise<void> { bump('disposeSlow'); await probe.saved[0]; } }\n" : ''}export class Holder {
  constructor(readonly req: Req, readonly retries: number${slow ? ', readonly slow: Slow' : ''}) { bump('buildHolder'); }
  dispose(): void { bump('disposeHolder'); if (probe.fail !== undefined) throw probe.fail; }
}
export class Eager { constructor(readonly req: Req) { bump('buildEager'); } }
const req = useInterface<Req>();
const twin = useInterface<Twin>();
const retries = useProperty<number>(Holder, 'retries');
const svc = useInterface<Svc>();
const ids = defineBuilderConfig({
  name: 'E18Ids',
  injections: [
    { token: req, useValue: { id: 'ids', user: 'ids' } },
    { token: twin, useValue: { id: 'ids', user: 'ids' } },
    { token: retries, useFactory: true, dependencies: [], provider: () => 0 },
  ],
});
${options.before ?? ''}
export const box = defineBuilderConfig({
  name: 'E18',
  runtime: { profile: '${cell.profile}' },
  ${options.useContainer ?? ''}
  scopeInputs: ${options.inputs ?? '[req, retries]'},
  ${closed}
  injections: [
    { token: Holder },
    ${slow ? '{ token: Slow },' : ''}
    { token: Eager },
    { token: svc, useFactory: true, dependencies: [Holder], provider: ${asyncFactory}(ctx) => { bump('buildSvc'); return { holder: ctx.resolve(Holder) }; } },
    ${options.extra ?? ''}
  ],
});
${options.after ?? ''}
`;
}

/** The text of the plain objects a scope is given, ids resolved. */
export interface Values {
  req: object;
  retries: number;
}

export interface Env {
  built: Built;
  /** The unbound model: what `defineBuilderConfig` returns. */
  box: object;
  req: string;
  twin: string;
  retries: string;
  /** How many times the counter `key` of the source was bumped. */
  count: (key: string) => number;
  /** `box.createScope({ values })` with the two inputs, in the order given (`req` first by default). */
  scope: (values?: unknown, from?: object) => object;
  /** The entries of both inputs. */
  entries: (value?: Partial<Values>) => unknown[];
}

export interface EnvOptions extends SourceOptions {
  testOverrides?: boolean;
  /** Generator `observation` (topic 22): the container has `observe()` and `stateSnapshot()`. Absent: off. */
  observation?: boolean;
  /** The helpers of the module are written once in front of the file, as the plugin session does (see `BuildOptions.shared`). */
  shared?: boolean;
}

/** Builds one cell, runs `scenario`, and always releases the model and the scopes the scenario made. */
export async function withEnv<T>(cell: Cell, options: EnvOptions, scenario: (env: Env) => Promise<T> | T): Promise<T> {
  const built = build(sourceFor(cell, options), { emitter: cell.emitter, testOverrides: options.testOverrides ?? false, observation: options.observation === true, shared: options.shared === true });
  const opened: object[] = [];
  try {
    const box = built.box();
    const req = built.id('Req');
    const twin = built.id('Twin');
    const retries = built.id('retries');
    const entries = (value: Partial<Values> = {}): unknown[] => [
      { token: req, useValue: value.req ?? { id: 'r1', user: 'ann' } },
      { token: retries, useValue: value.retries ?? 3 },
    ];
    return await scenario({
      built,
      box,
      req,
      twin,
      retries,
      count: (key) => built.probe.counts[key] ?? 0,
      entries,
      scope: (values, from = box) => {
        const scope = createScope(from, { values: values ?? entries() });
        if (typeof scope === 'object' && scope !== null) opened.push(scope);
        if (typeof scope !== 'object' || scope === null) throw new Error('createScope did not answer a container');
        return scope;
      },
    });
  } finally {
    for (const scope of opened.reverse()) {
      try {
        await call(scope, 'destroy');
      } catch (error) {
        if (readKey(error, 'code') !== 'NEO_CONTAINER_DESTROYED') throw error;
      }
    }
    await built.close();
  }
}

export interface Deferred {
  promise: Promise<void>;
  open: () => void;
}

/** A promise a test settles itself: `probe.saved[0]` is what the async `dispose` of `Slow` waits for. */
export function deferred(): Deferred {
  let open = (): void => {};
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, open };
}

/** The graph of the container under test. */
export function graphOf(built: Built): DependencyGraph {
  const graph = built.graphs.find((candidate) => candidate.containerName === 'E18');
  if (!graph) throw new Error('missing graph E18');
  return graph;
}

/**
 * Every test of the topic starts here: the analysis knows the two inputs of the container, in the order of the list.
 * Today `scopeInputs` is ignored, so the graph has no such field.
 */
export function capabilityInputs(built: Built, declared: readonly string[] = [built.id('Req'), built.id('retries')]): void {
  const inputs: unknown = readKey(graphOf(built), 'scopeInputs');
  const ids = Array.isArray(inputs) ? inputs.map((input) => readKey(input, 'tokenId')) : undefined;
  expect(ids, 'the graph lists the scope inputs').toEqual([...declared]);
}

/** `owner[name](...args)`, called through `Reflect` on `unknown`. */
export function call(owner: unknown, name: string, args: readonly unknown[] = []): Promise<unknown> {
  const member: unknown = readKey(owner, name);
  if (typeof member !== 'function') throw new Error(`${name} is not a function`);
  const result: unknown = Reflect.apply(member, owner, args);
  return Promise.resolve(result);
}

/** `owner.createScope(options)`, called through `Reflect` on `unknown`. */
export function createScope(owner: unknown, options?: unknown): unknown {
  const member: unknown = readKey(owner, 'createScope');
  if (typeof member !== 'function') throw new Error('createScope is not a function');
  return Reflect.apply(member, owner, options === undefined ? [] : [options]);
}

/** `owner.resolve(token)`, `resolveAll(token)` or `resolveMany(tokens)`, through `Reflect` on `unknown`. */
export function use(owner: unknown, name: 'resolve' | 'resolveAll' | 'resolveMany', argument: unknown): unknown {
  const member: unknown = readKey(owner, name);
  if (typeof member !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(member, owner, [argument]);
}

export interface Failure {
  code: string;
  message: string;
}

function failureOf(error: unknown): Failure {
  const code = readKey(error, 'code');
  const message = readKey(error, 'message');
  return { code: typeof code === 'string' ? code : '', message: typeof message === 'string' ? message : '' };
}

/** The code and message of what a synchronous call throws, `{ code: '', message: '' }` when it answers. */
export function thrown(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    return failureOf(error);
  }
  return { code: '', message: '' };
}

/** The code and message of a rejection, `{ code: '', message: '' }` when the promise resolves. */
export async function failure(work: () => Promise<unknown>): Promise<Failure> {
  try {
    await work();
  } catch (error) {
    return failureOf(error);
  }
  return { code: '', message: '' };
}

/** The name a token id is shown under in a message: the id without its trailing hash. */
export function shown(id: string): string {
  return id.replace(/_[a-f0-9]{6,12}$/i, '');
}

/** The text of the generated container from `from` to the first of `until` found after it. */
export function slice(text: string, from: string, until: readonly string[]): string {
  const start = text.indexOf(from);
  expect(start, `generated text has ${from}`).toBeGreaterThanOrEqual(0);
  const ends = until.map((marker) => text.indexOf(marker, start + from.length)).filter((index) => index >= 0);
  return text.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}
