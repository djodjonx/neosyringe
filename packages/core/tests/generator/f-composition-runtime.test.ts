import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { build, HEAD, type Built, type Emitter } from '../helpers/e17-build';
import { overridesOf } from '../helpers/e16-build';
import {
  BINDINGS,
  constructionPairs,
  describeOp,
  describeProbe,
  disposalPairs,
  runCompositionModel,
  type Binding,
  type CompositionEvent,
  type CompositionOp,
  type CompositionScenario,
  type Token,
  probeAsOp,
} from '../helpers/f-composition-model';
import { MATRIX, label, member, withRun, type Cell, type Run, type Spec } from '../helpers/f-build';

/**
 * Integration of the stage F features (proof `integration-composition`, implementation/REVUE-FINALE.md, "Qualification a
 * ajouter"). I1 runs one graph that holds scope inputs, an alias, `resolveMany`, a bounded concurrent initialization, a
 * `useContainer` parent and disposers, on the generated code of both emitters, full and minimal, open and closed, and
 * compares every answer with `f-composition-model.ts`, a model that imports no generator code. I2 is the full-profile
 * scenario of `overrideMany` while a destroy is requested, in flight or over, and while an initialization is cancelling.
 * I3 reads the emitted text: one state authority. Every container is reached through `Reflect` on `unknown`.
 *
 * Cells that are not admissible, and why (the refusal is the analyzer's, found by building them):
 * - minimal, for I2: the scenario is about `overrideMany`, which the minimal profile never emits (the reference emitter
 *   passes no `manyNames` for it, packages/core/src/generator/Generator.ts:629; the optimized emitter emits no override
 *   method at all, packages/core/src/generator/DirectEmitter.ts:406). The reference emitter does write `override` and
 *   `clearOverrides` for minimal, which its public type does not expose (docs/guide/states-and-ownership.md:19); no step
 *   here calls them on that cell. So I2 runs on the full profile and I1 makes no override call;
 * - closed with an input among the `roots`: `NEO_MISSING_PROVIDER: root 'Req' is not registered.` (an input is bound by
 *   `createScope`, it has no registration), so the closed roots are the services and the alias, never `Req` or `Lim`.
 * Every other cell of the matrix (both emitters x full/minimal x open/closed) builds and is compared.
 */

const REASON = new Error('stop initializing');

const CONCURRENCY: readonly number[] = [1, 3];

/** The graph under test. `ROOTS` are the roots of a closed cell, the alias included. */
function compositionSource(cell: Pick<Cell, 'profile' | 'mode'>, concurrency: number): string {
  const closed = cell.mode === 'closed' ? 'optimization: { mode: "closed", roots: [c, d, twin, B, E] },' : '';
  return `${HEAD}
interface Req { id: string }
interface Lim { n: number }
interface IC { tag: string }
interface ID { tag: string }
interface ITwin { tag: string }
const bump = (key: string): void => { probe.counts[key] = (probe.counts[key] ?? 0) + 1; probe.log.push(key); };
const enter = (): void => {
  const running = (probe.counts.active ?? 0) + 1;
  probe.counts.active = running;
  probe.counts.peak = Math.max(probe.counts.peak ?? 0, running);
};
const leave = (): void => { probe.counts.active = (probe.counts.active ?? 0) - 1; };
const req = useInterface<Req>();
const lim = useInterface<Lim>();
const c = useInterface<IC>();
const d = useInterface<ID>();
const twin = useInterface<ITwin>();
export class Base {
  readonly tag = 'Base';
  constructor() { bump('build:Base'); }
  dispose(): void { bump('dispose:Base'); }
}
export class A {
  readonly tag: string;
  constructor(readonly req: Req, readonly base: Base) { bump('build:A'); this.tag = 'A[' + req.id + ']'; }
  dispose(): void { bump('dispose:A'); }
}
export class B {
  readonly tag: string;
  constructor(readonly a: A, readonly lim: Lim) { bump('build:B'); this.tag = 'B[' + lim.n + ',' + a.tag + ']'; }
  dispose(): void { bump('dispose:B'); }
}
export class E {
  readonly tag: string;
  constructor(readonly lim: Lim) { bump('build:E'); this.tag = 'E[' + lim.n + ']'; }
  dispose(): void { bump('dispose:E'); }
}
export const parent = defineBuilderConfig({
  name: 'Parent',
  injections: [{ token: Base }],
});
export const box = defineBuilderConfig({
  name: 'Box',
  runtime: { profile: '${cell.profile}' },
  useContainer: parent,
  scopeInputs: [req, lim],
  initialization: { concurrency: ${concurrency} },
  ${closed}
  injections: [
    { token: A },
    { token: B },
    { token: E },
    { token: c, useFactory: true, dependencies: [], provider: async () => {
      enter();
      try { await probe.saved[0]; bump('build:c'); return { tag: 'c', dispose() { bump('dispose:c'); } }; } finally { leave(); }
    } },
    { token: d, useFactory: true, dependencies: [B], provider: async (ctx) => {
      enter();
      try { await probe.saved[1]; bump('build:d'); return { tag: 'd[' + ctx.resolve(B).tag + ']', dispose() { bump('dispose:d'); } }; } finally { leave(); }
    } },
    { token: twin, useExisting: B },
  ],
});
`;
}

/** The token a test passes for each name: an interface token is its runtime key, a class token is the class. */
function tokenOf(built: Built, token: Token): unknown {
  if (token === 'c') return built.id('IC');
  if (token === 'd') return built.id('ID');
  if (token === 'twin') return built.id('ITwin');
  const exported = built.exports[token];
  if (exported === undefined) throw new Error(`missing export ${token}`);
  return exported;
}

function valuesOf(built: Built, binding: Binding): unknown {
  const req = { token: built.id('Req'), useValue: { id: binding === 'missing' ? 'x' : BINDINGS[binding].id } };
  if (binding === 'missing') return { values: [req] };
  return { values: [req, { token: built.id('Lim'), useValue: { n: BINDINGS[binding].n } }] };
}

function codeOf(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : error.name;
}

function tagOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const tag: unknown = Reflect.get(value, 'tag');
    if (typeof tag === 'string') return tag;
  }
  return 'other';
}

function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method = member(owner, name);
  if (method === undefined) throw new Error(`missing member ${name}`);
  return method(...args);
}

interface Deferred {
  promise: Promise<void>;
  open: () => void;
}

function deferred(): Deferred {
  let open = (): void => {};
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, open };
}

/** What a run of the generated code did, next to what the model says it must have done. */
interface Observed {
  readonly events: CompositionEvent[];
  readonly constructs: Record<string, number>;
  readonly disposals: Record<string, number>;
  /** The largest number of factories that ran at once, over the whole run. */
  readonly peak: number;
  /** An order the graph forces (a dependency is built first, a consumer is disposed first) that a step did not keep. */
  readonly misordered: string[];
}

function tally(log: readonly string[], prefix: 'build:' | 'dispose:'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of log) {
    if (!entry.startsWith(prefix)) continue;
    const name = entry.slice(prefix.length);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function misorderedIn(segment: readonly string[], prefix: 'build:' | 'dispose:', pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const found: string[] = [];
  for (const [first, later] of pairs) {
    const a = segment.indexOf(`${prefix}${first}`);
    const b = segment.indexOf(`${prefix}${later}`);
    if (a >= 0 && b >= 0 && a > b) found.push(`${prefix}${later} before ${prefix}${first}`);
  }
  return found;
}

/** Runs the scenario on the generated code of one cell. Gates, scopes and containers are always released. */
async function runGenerated(cell: Cell, scenario: CompositionScenario): Promise<Observed> {
  const built = build(compositionSource(cell, scenario.concurrency), { emitter: cell.emitter });
  const box = built.box('box');
  const gates = [deferred(), deferred()];
  built.probe.saved.push(gates[0]?.promise, gates[1]?.promise);
  const scopes: object[] = [box];
  const events: CompositionEvent[] = [];
  const misordered: string[] = [];
  try {
    for (const op of scenario.ops) {
      const mark = built.probe.log.length;
      const answer = await perform(built, scopes, op, gates);
      const segment = built.probe.log.slice(mark);
      misordered.push(...misorderedIn(segment, 'build:', constructionPairs()), ...misorderedIn(segment, 'dispose:', disposalPairs()));
      events.push(...(answer.before ?? []));
      events.push({
        op: describeOp(op),
        ...answer.result,
        built: Object.keys(tally(segment, 'build:')).sort(),
        disposed: Object.keys(tally(segment, 'dispose:')).sort(),
        running: answer.running,
      });
    }
    return {
      events,
      constructs: tally(built.probe.log, 'build:'),
      disposals: tally(built.probe.log, 'dispose:'),
      peak: built.probe.counts.peak ?? 0,
      misordered,
    };
  } finally {
    await release(built, scopes, gates);
  }
}

/** Opens the gates, destroys the scopes made, then the containers; a scope the scenario destroyed already is fine. */
async function release(built: Built, scopes: readonly object[], gates: readonly Deferred[]): Promise<void> {
  for (const gate of gates) gate.open();
  await tick();
  for (const scope of scopes.slice(1).reverse()) {
    try {
      await call(scope, 'destroy');
    } catch (error) {
      if (codeOf(error) !== 'NEO_CONTAINER_DESTROYED') throw error;
    }
  }
  await built.close();
}

interface Answer {
  readonly result: Pick<CompositionEvent, 'code' | 'value' | 'delivery'>;
  readonly running: number;
  /** The events of the calls made while a held initialization was in flight, in the order they were made. */
  readonly before?: readonly CompositionEvent[];
}

function scopeAt(scopes: readonly object[], index: number): object {
  const scope = scopes[index];
  if (scope === undefined) throw new Error(`the scenario names scope ${index}, which was never made`);
  return scope;
}

async function perform(built: Built, scopes: object[], op: CompositionOp, gates: readonly Deferred[]): Promise<Answer> {
  const value = (text: string): Answer => ({ result: { code: '', value: text, delivery: 'value' }, running: -1 });
  const sync = (error: unknown): Answer => ({ result: { code: codeOf(error), value: '', delivery: 'sync' }, running: -1 });
  const attempt = (run: () => unknown): Answer => {
    try {
      return value(tagOf(run()));
    } catch (error) {
      return sync(error);
    }
  };
  if (op.kind === 'resolveUnbound') {
    return attempt(() => call(scopeAt(scopes, 0), 'resolve', tokenOf(built, op.token)));
  }
  if (op.kind === 'createScope') {
    try {
      scopes.push(objectOf(call(scopeAt(scopes, op.from), 'createScope', valuesOf(built, op.binding))));
      return value('scope');
    } catch (error) {
      return sync(error);
    }
  }
  if (op.kind === 'resolve') {
    return attempt(() => call(scopeAt(scopes, op.scope), 'resolve', tokenOf(built, op.token)));
  }
  if (op.kind === 'resolveMany') {
    try {
      const answers: unknown = call(scopeAt(scopes, op.scope), 'resolveMany', op.tokens.map((token) => tokenOf(built, token)));
      if (!Array.isArray(answers)) throw new Error('resolveMany did not answer an array');
      return value(`[${answers.map(tagOf).join('|')}]`);
    } catch (error) {
      return sync(error);
    }
  }
  if (op.kind === 'destroy') {
    return settled(call(scopeAt(scopes, op.scope), 'destroy'), -1);
  }
  if (op.kind === 'destroyParent') {
    return settled(call(objectOf(built.exports.parent), 'destroy'), -1);
  }
  // initialize: a held one reads how many factories run at once before it lets them go.
  const pending = call(scopeAt(scopes, op.scope), 'initialize');
  const outcome = settled(pending, -1);
  if (op.held !== true) {
    for (const gate of gates) gate.open();
    return outcome;
  }
  await tick();
  const running = built.probe.counts.active ?? 0;
  const before: CompositionEvent[] = [];
  for (const probe of op.during ?? []) {
    const mark = built.probe.log.length;
    const answer = await perform(built, scopes, probeAsOp(op.scope, probe), gates);
    const segment = built.probe.log.slice(mark);
    before.push({
      op: describeProbe(op.scope, probe),
      ...answer.result,
      built: Object.keys(tally(segment, 'build:')).sort(),
      disposed: Object.keys(tally(segment, 'dispose:')).sort(),
      running: -1,
    });
  }
  for (const gate of gates) gate.open();
  return { ...(await outcome), running, before };
}

async function settled(promise: unknown, running: number): Promise<Answer> {
  if (!(promise instanceof Promise)) throw new Error('not a promise');
  try {
    await promise;
    return { result: { code: '', value: '', delivery: 'value' }, running };
  } catch (error) {
    return { result: { code: codeOf(error), value: '', delivery: 'reject' }, running };
  }
}

function objectOf(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return value;
}

/**
 * The main scenario. Container 0 is given no inputs; scope 1 and 2 are made from it with their own values and share the
 * parent. Every step is one rule of the topics: unbound and missing inputs, before initialize, a held initialization,
 * values of two scopes that do not cross, the alias, a batch that stops on a refusal, a scope that is closed and never
 * reopens, a parent that is closed under a live scope.
 */
function mainScenario(mode: 'open' | 'closed', concurrency: number): CompositionScenario {
  const ops: CompositionOp[] = [
    { kind: 'resolveUnbound', token: 'c' },
    { kind: 'createScope', from: 0, binding: 'missing' },
    { kind: 'createScope', from: 0, binding: 'one' },
    { kind: 'resolve', scope: 1, token: 'c' },
    { kind: 'resolveMany', scope: 1, tokens: ['c'] },
    { kind: 'createScope', from: 0, binding: 'two' },
    {
      kind: 'initialize',
      scope: 1,
      held: true,
      during: [
        { kind: 'resolve', token: 'c' },
        { kind: 'resolve', token: 'twin' },
        { kind: 'resolveMany', tokens: ['c', 'd'] },
        { kind: 'resolveMany', tokens: [] },
        { kind: 'createScope', binding: 'one' },
      ],
    },
    { kind: 'initialize', scope: 1 },
    { kind: 'resolveMany', scope: 1, tokens: ['c', 'd', 'twin', 'B'] },
    { kind: 'resolve', scope: 1, token: 'twin' },
    { kind: 'resolveMany', scope: 1, tokens: ['E', 'A', 'c'] },
    { kind: 'resolve', scope: 1, token: 'A' },
    { kind: 'resolve', scope: 1, token: 'Base' },
    { kind: 'initialize', scope: 2 },
    { kind: 'resolve', scope: 2, token: 'd' },
    { kind: 'resolveMany', scope: 2, tokens: ['B', 'twin', 'c'] },
    { kind: 'destroy', scope: 1 },
    { kind: 'resolve', scope: 1, token: 'c' },
    { kind: 'resolveMany', scope: 1, tokens: [] },
    { kind: 'initialize', scope: 1 },
    { kind: 'createScope', from: 1, binding: 'one' },
    { kind: 'destroy', scope: 1 },
    { kind: 'resolve', scope: 2, token: 'c' },
    { kind: 'destroyParent' },
    { kind: 'resolve', scope: 2, token: 'd' },
    { kind: 'resolveMany', scope: 2, tokens: ['c'] },
    { kind: 'createScope', from: 0, binding: 'one' },
    { kind: 'destroy', scope: 2 },
    { kind: 'destroy', scope: 2 },
    { kind: 'destroyParent' },
    { kind: 'destroy', scope: 0 },
    { kind: 'createScope', from: 0, binding: 'one' },
  ];
  return { ops, mode, concurrency };
}

/** The parent is closed first: the scope that lives on is refused, and still releases its own services once. */
function parentFirstScenario(mode: 'open' | 'closed', concurrency: number): CompositionScenario {
  const ops: CompositionOp[] = [
    { kind: 'createScope', from: 0, binding: 'two' },
    { kind: 'initialize', scope: 1 },
    { kind: 'resolve', scope: 1, token: 'B' },
    { kind: 'destroyParent' },
    { kind: 'resolve', scope: 1, token: 'B' },
    { kind: 'resolveMany', scope: 1, tokens: ['c', 'd'] },
    { kind: 'destroy', scope: 1 },
    { kind: 'destroy', scope: 1 },
    { kind: 'destroyParent' },
  ];
  return { ops, mode, concurrency };
}

const SCENARIOS: ReadonlyArray<{ title: string; make: (mode: 'open' | 'closed', concurrency: number) => CompositionScenario }> = [
  { title: 'inputs, alias, batch, concurrent init, parent, disposal', make: mainScenario },
  { title: 'the parent is closed under a live scope', make: parentFirstScenario },
];

describe('I1 composition of scope inputs, alias, resolveMany, concurrent initialization, parent and disposal', () => {
  for (const cell of MATRIX) {
    for (const concurrency of CONCURRENCY) {
      for (const scenario of SCENARIOS) {
        it(`I1 composition matrix equals the independent model: ${scenario.title} (N=${concurrency}, ${label(cell)})`, async () => {
          const plan = scenario.make(cell.mode, concurrency);
          const expected = runCompositionModel(plan);
          const actual = await runGenerated(cell, plan);
          expect(actual.events).toEqual(expected.events);
          expect(actual.constructs).toEqual(expected.constructs);
          expect(actual.disposals).toEqual(expected.disposals);
          // No double destruction: a service is disposed at most as often as it was built, and the order the graph forces holds.
          for (const [name, disposed] of Object.entries(actual.disposals)) {
            expect(disposed, `${name} is disposed once per construction`).toBeLessThanOrEqual(actual.constructs[name] ?? 0);
          }
          expect(actual.misordered).toEqual([]);
          expect(actual.peak).toBeLessThanOrEqual(concurrency);
        });
      }
    }
  }
});

// -- I2 ------------------------------------------------------------------------------------------------------------

const MODES: ReadonlyArray<{ title: string; options: { concurrency?: number } }> = [
  { title: 'N=1', options: {} },
  { title: 'N=3', options: { concurrency: 3 } },
];

/** Full profile only: the scenarios of I2 are about `overrideMany`, which the minimal profile never emits. */
const FULL: readonly Cell[] = MATRIX.filter((cell) => cell.profile === 'full');

const MOCK = (): unknown => ({ name: 'mock' });

function nameOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, 'name') : undefined;
}

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

async function rejection(promise: unknown): Promise<unknown> {
  const watched = watch(promise);
  await tick();
  expect(watched.done, 'the call answered without waiting').toBe(true);
  expect(watched.ok, 'the call was refused').toBe(false);
  return watched.error;
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function settleAll(run: Run): Promise<void> {
  await run.settle();
  await run.settle();
}

/** The overrides a container holds: a mock installed after a close would be an entry here. */
function mocksOf(run: Run): number {
  return overridesOf(run.box).size;
}

/** The code `resolve` and `resolveMany` throw on the container right now, in this order. A call that does not throw gives ''. */
function resolutionCodes(run: Run, name: string): readonly string[] {
  return [
    codeOf(thrownBy(() => call(run.box, 'resolve', run.token(name)))),
    codeOf(thrownBy(() => call(run.box, 'resolveMany', [run.token(name)]))),
  ];
}

function overrideManyOf(run: Run, name: string): unknown {
  return call(run.box, 'overrideMany', [[run.token(name), MOCK]]);
}

describe('I2 overrideMany while a destroy is requested, in flight, over, or while an initialization is cancelling', () => {
  for (const cell of FULL) {
    for (const mode of MODES) {
      const options = { ...mode.options, testOverrides: true };

      it(`I2 a destroy pending on a slow disposer refuses overrideMany as BUSY and installs no mock, then the container stays closed (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', disposeGate: true }];
        await withRun(cell, specs, options, async (run) => {
          expect((await run.start().settled).ok).toBe(true);
          run.ctl.hold('A:dispose');
          const destroying = watch(call(run.box, 'destroy'));
          await settleAll(run);
          expect(destroying.done, 'destroy waits for the slow disposer').toBe(false);
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_BUSY');
          expect(mocksOf(run), 'no mock installed while the destroy is pending').toBe(0);
          // Destroying answers as destroyed (packages/core/src/generator/LifecycleEmitter.ts:691): no resolution, no scope.
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while the destroy is pending').toEqual(['NEO_CONTAINER_DESTROYED', 'NEO_CONTAINER_DESTROYED']);
          expect(codeOf(thrownBy(() => call(run.box, 'createScope'))), 'createScope while the destroy is pending').toBe('NEO_CONTAINER_DESTROYED');
          expect(run.ctl.disposed.get('A')).toBe(1);
          run.ctl.open('A:dispose');
          await settleAll(run);
          expect(destroying.ok).toBe(true);
          expect(run.ctl.disposed.get('A'), 'the disposer ran once for the destroy').toBe(1);
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_DESTROYED');
          expect(mocksOf(run), 'no mock installed once the container is closed').toBe(0);
        });
      });

      // `_guardPublic` answers 'destroying' itself (packages/core/src/generator/LifecycleEmitter.ts:691). The interior of
      // `resolve` skips its closed check while an initialization still runs (packages/core/src/generator/ResolveEmitter.ts:71),
      // so only a destroy requested during a held initialization reaches this branch: nothing else answers there.
      it(`I2 a destroy requested during a held initialization refuses resolve and resolveMany as DESTROYED and builds nothing (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', dispose: true }];
        await withRun(cell, specs, options, async (run) => {
          run.ctl.hold('A');
          const init = run.start();
          await run.settle();
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while initializing').toEqual(['NEO_NOT_INITIALIZED', 'NEO_NOT_INITIALIZED']);
          const destroying = watch(call(run.box, 'destroy'));
          await settleAll(run);
          expect(destroying.done, 'destroy waits for the initialization that still runs').toBe(false);
          const built = run.ctl.built.get('A') ?? 0;
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while destroying with an initialization running').toEqual(['NEO_CONTAINER_DESTROYED', 'NEO_CONTAINER_DESTROYED']);
          expect(run.ctl.built.get('A') ?? 0, 'the refused resolution built nothing').toBe(built);
          run.ctl.openAll();
          await settleAll(run);
          await init.settled;
          expect(destroying.done, 'destroy ends once the initialization has ended').toBe(true);
          expect(run.ctl.disposed.get('A') ?? 0, 'A is disposed once per construction').toBe(run.ctl.built.get('A') ?? 0);
        });
      });

      it(`I2 overrideMany in flight refuses destroy as BUSY, then a later destroy succeeds and disposes nothing twice (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', disposeGate: true }];
        await withRun(cell, specs, options, async (run) => {
          expect((await run.start().settled).ok).toBe(true);
          run.ctl.hold('A:dispose');
          const batch = watch(overrideManyOf(run, 'A'));
          await settleAll(run);
          expect(batch.done, 'the batch waits for the disposer of the cached value').toBe(false);
          expect(codeOf(await rejection(call(run.box, 'destroy')))).toBe('NEO_CONTAINER_BUSY');
          // Reconfiguring (docs/guide/states-and-ownership.md, table "States"): resolution, scope and initialize are all BUSY.
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while the batch is in flight').toEqual(['NEO_CONTAINER_BUSY', 'NEO_CONTAINER_BUSY']);
          expect(codeOf(thrownBy(() => call(run.box, 'createScope'))), 'createScope while the batch is in flight').toBe('NEO_CONTAINER_BUSY');
          expect(codeOf(await rejection(call(run.box, 'initialize'))), 'initialize while the batch is in flight').toBe('NEO_CONTAINER_BUSY');
          expect(run.ctl.disposed.get('A'), 'the refused destroy disposed nothing more').toBe(1);
          run.ctl.open('A:dispose');
          await settleAll(run);
          expect(batch.ok).toBe(true);
          // The batch dropped the cache: the container is initialized again, and then A answers the mock.
          expect((await run.start().settled).ok).toBe(true);
          expect(nameOf(call(run.box, 'resolve', run.token('A'))), 'resolve of A answers the mock the batch installed').toBe('mock');
          expect(mocksOf(run), 'the batch installed its mock once it was over').toBe(1);
          await call(run.box, 'destroy');
          expect(run.ctl.disposed.get('A'), 'every disposer is called exactly once').toBe(1);
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_DESTROYED');
        });
      });

      it(`I2 after destroy overrideMany is DESTROYED, nothing reopens and every disposer was called once (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', dispose: true }, { name: 'B', deps: ['A'], dispose: true }];
        await withRun(cell, specs, options, async (run) => {
          expect((await run.start().settled).ok).toBe(true);
          await call(run.box, 'destroy');
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_DESTROYED');
          expect(codeOf(await rejection(call(run.box, 'override', run.token('A'), MOCK)))).toBe('NEO_CONTAINER_DESTROYED');
          expect(codeOf(await rejection(call(run.box, 'clearOverrides')))).toBe('NEO_CONTAINER_DESTROYED');
          expect(codeOf(await rejection(call(run.box, 'initialize')))).toBe('NEO_CONTAINER_DESTROYED');
          expect(codeOf(thrownBy(() => call(run.box, 'resolve', run.token('A'))))).toBe('NEO_CONTAINER_DESTROYED');
          expect(codeOf(thrownBy(() => call(run.box, 'createScope')))).toBe('NEO_CONTAINER_DESTROYED');
          expect(mocksOf(run)).toBe(0);
          await call(run.box, 'destroy');
          expect(run.ctl.disposed.get('A')).toBe(1);
          expect(run.ctl.disposed.get('B')).toBe(1);
        });
      });

      it(`I2 while an initialization is cancelling overrideMany and createScope are BUSY and install nothing (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', dispose: true }, { name: 'B', dispose: true }];
        await withRun(cell, specs, options, async (run) => {
          run.ctl.hold('A', 'B');
          const controller = new AbortController();
          const init = run.start({ signal: controller.signal });
          await run.settle();
          // Initializing: nothing resolves yet, nothing is reconfigured, no scope is made.
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while initializing').toEqual(['NEO_NOT_INITIALIZED', 'NEO_NOT_INITIALIZED']);
          expect(codeOf(thrownBy(() => call(run.box, 'createScope'))), 'createScope while initializing').toBe('NEO_CONTAINER_BUSY');
          expect(codeOf(await rejection(overrideManyOf(run, 'A'))), 'overrideMany while initializing').toBe('NEO_CONTAINER_BUSY');
          expect(mocksOf(run), 'no mock installed while initializing').toBe(0);
          controller.abort(REASON);
          await run.settle();
          // The caller has stopped waiting; the factories still run, so the container is cancelling.
          expect((await init.settled).error).toBe(REASON);
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany while cancelling').toEqual(['NEO_NOT_INITIALIZED', 'NEO_NOT_INITIALIZED']);
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_BUSY');
          expect(mocksOf(run), 'no mock installed while the initialization is cancelling').toBe(0);
          const refused = thrownBy(() => call(run.box, 'createScope'));
          expect(codeOf(refused), 'createScope is refused while cancelling').toBe('NEO_CONTAINER_BUSY');
          run.ctl.openAll();
          await settleAll(run);
          expect(codeOf(await rejection(overrideManyOf(run, 'A'))), 'the failed container refuses too').toBe('NEO_CONTAINER_FAILED');
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany once the cancelled initialization has ended').toEqual(['NEO_CONTAINER_FAILED', 'NEO_CONTAINER_FAILED']);
          expect(mocksOf(run)).toBe(0);
          for (const name of ['A', 'B']) {
            expect(run.ctl.disposed.get(name) ?? 0, `${name} is disposed once per construction`).toBe(run.ctl.built.get(name) ?? 0);
          }
        });
      });

      it(`I2 after a failed initialization resolve, resolveMany and createScope are FAILED and overrideMany installs nothing (${mode.title}, ${label(cell)})`, async () => {
        const specs: Spec[] = [{ name: 'A', dispose: true }, { name: 'B', dispose: true }];
        await withRun(cell, specs, options, async (run) => {
          const boom = new Error('factory failed');
          run.ctl.failWith('B', boom);
          expect((await run.start().settled).error).toBe(boom);
          expect(resolutionCodes(run, 'A'), 'resolve and resolveMany on a failed container').toEqual(['NEO_CONTAINER_FAILED', 'NEO_CONTAINER_FAILED']);
          expect(codeOf(thrownBy(() => call(run.box, 'createScope'))), 'createScope on a failed container').toBe('NEO_CONTAINER_FAILED');
          expect(codeOf(await rejection(overrideManyOf(run, 'A')))).toBe('NEO_CONTAINER_FAILED');
          expect(mocksOf(run)).toBe(0);
          expect((await run.start().settled).error, 'the next initialize rejects with the first error').toBe(boom);
        });
      });
    }
  }
});

// -- I3 ------------------------------------------------------------------------------------------------------------

const EMITTER_LIST: readonly Emitter[] = ['reference', 'optimized'];

/**
 * A field declaration of the emitted class, which writes its members at two spaces: with or without a modifier, and a `#`
 * private name too. Group 1 is the name. A method (`name(`) and a statement inside a method (deeper) are not one.
 */
const FIELD_PREFIX = String.raw`^ {2}(?:(?:private|public|protected|static|readonly|declare|override)\s+)*(#?\w+)[?!]?`;
const CLASS_FIELD = new RegExp(`${FIELD_PREFIX}\\s*[:=;]`, 'gm');
const ENUMERATED_FIELD = new RegExp(`${FIELD_PREFIX}\\s*:[^\\n]*'destroying' \\| 'destroyed'[^\\n]*`, 'gm');

/** The fields of the emitted class whose declaration spells the lifecycle states. A type alias (the snapshot's view) is not one. */
function enumerations(text: string): string[] {
  return text.match(ENUMERATED_FIELD) ?? [];
}

/** Every declared field of the emitted class whose name says it holds a lifecycle state. */
function stateFields(text: string): string[] {
  return [...text.matchAll(CLASS_FIELD)]
    .map((match) => match[1] ?? '')
    .filter((name) => /state|status|phase|lifecycle|stage/i.test(name));
}

describe('I3 one state authority', () => {
  it('I3 the check sees a second state field, whatever way it is declared', () => {
    const emitted = [
      '  private _state: \'created\' | \'destroying\' | \'destroyed\' = \'created\';',
      '  _phase = 0;',
      '  #lifecycle = 1;',
      '  private static readonly stage: number = 2;',
      '  public status?: string;',
      '  private foo(): void {',
      '    phase = 3;',
      '  }',
    ].join('\n');
    expect(stateFields(emitted)).toEqual(['_state', '_phase', '#lifecycle', 'stage', 'status']);
    expect(enumerations(emitted)).toHaveLength(1);
    expect(enumerations(emitted.replace('  _phase = 0;', "  _phase: 'destroying' | 'destroyed' = 'destroyed';"))).toHaveLength(2);
  });

  for (const emitter of EMITTER_LIST) {
    for (const profile of ['full', 'minimal'] as const) {
      it(`I3 an async container declares exactly one _state and no second lifecycle state (${emitter} ${profile})`, async () => {
        const text = build(compositionSource({ profile, mode: 'open' }, 3), { emitter }).generated[0] ?? '';
        expect(text.match(/private _state\b/g)).toHaveLength(1);
        expect(enumerations(text), 'one field is typed with the lifecycle states').toHaveLength(1);
        expect(stateFields(text)).toEqual(['_state']);
      });

      it(`I3 the same holds for an observed, override-enabled container with a parent and an alias (${emitter} ${profile})`, async () => {
        const cell: Cell = { emitter, profile, mode: 'open' };
        const specs: Spec[] = [{ name: 'A', dispose: true }, { name: 'B', deps: ['A'] }, { name: 'T', alias: 'B' }];
        await withRun(cell, specs, { concurrency: 3, testOverrides: true, observation: true, parent: [{ name: 'P' }] }, (run) => {
          expect(run.text.match(/private _state\b/g)).toHaveLength(1);
          expect(enumerations(run.text)).toHaveLength(1);
          expect(stateFields(run.text)).toEqual(['_state']);
        });
      });

      it(`I3 a sync container has no _state: its authority is _closed, _failure and _reconfiguring, each declared at most once (${emitter} ${profile})`, async () => {
        const source = `${HEAD}
export class S { dispose(): void { bump('dispose:S'); } }
const bump = (key: string): void => { probe.log.push(key); };
export const box = defineBuilderConfig({ name: 'Sync', runtime: { profile: '${profile}' }, injections: [{ token: S }] });
`;
        const text = build(source, { emitter }).generated[0] ?? '';
        expect(text.match(/private _state\b/g)).toBeNull();
        expect(stateFields(text)).toEqual([]);
        for (const field of ['_closed', '_failure']) {
          expect(text.match(new RegExp(`private ${field}\\b`, 'g')), field).toHaveLength(1);
        }
        // The flag is declared once where the container can reconfigure: the full profile, and the reference emitter in both.
        expect(text.match(/private _reconfiguring\b/g)?.length ?? 0, '_reconfiguring').toBe(profile === 'full' || emitter === 'reference' ? 1 : 0);
      });
    }
  }
});
