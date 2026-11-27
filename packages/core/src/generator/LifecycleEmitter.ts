import type { DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../analyzer/types';
import { getFactoryName, multiRegistrationKey, resolveTokenKey, type GetImport } from './FactoryEmitter';
import { emitOverrideMany, type ManyNames } from './manyEmitter';
import { boundInitializeGuard, hasScopeInputs, inputCreateScopeMethod, inputDestroyMethod } from './inputEmitter';
import { MinIndexQueue } from './minHeap';
import { afterStore, isBorrowedInstance, overrideTokenChecks } from './ResolveEmitter';
import { aliasPlanOf, orderingDependencies } from '../analyzer/shared/aliasLinks';
import { signalTypeName } from './signalEmitter';
import { observeBegin } from './observationEmitter';

/**
 * What a cached singleton is read as when it is disposed. The cache holds `unknown`; one assertion
 * per read states what the slot guarantees. `unguarded`: the analyzer found a `dispose` method, so the
 * call is made as is (a missing one throws the same TypeError as before). `guarded`: the factory may
 * return anything, or the disposer is keyed by a symbol, so `_neoDisposer` looks it up first.
 */
const DISPOSABLE = '{ dispose(): unknown }';

/**
 * What `_assertParents` reads of a `useContainer` parent. A parent is a container or an adapter, and either
 * may carry a closed flag and a name. A container keeps both private, so they cannot be part of the shape
 * `legacy` is typed with (a class with a private member is not assignable to a shape that lists it);
 * each read states the shape it needs and nothing else. The read is inline so no statement is added.
 */
const LEGACY_STATE = '{ _closed?: boolean; name?: string }';
const MAYBE_DISPOSABLE = '{ dispose?: () => unknown } | null | undefined';

/**
 * The disposer of a value, found when the container is disposed: a callable `dispose` first, then `[Symbol.asyncDispose]`,
 * then `[Symbol.dispose]`. One method is chosen and it is called once, on the value itself. A value with none gets
 * `undefined`; a protocol that is neither callable nor null is refused with a TypeError, which the disposal collects
 * like any other failure. The symbols are read from `Symbol` when a value is disposed, never when the module loads, and
 * through an intersection type so that the output type-checks without the disposable lib (lib es2021, docs/release/compatibility.md,
 * "Floor of the emitted code"). Nothing is installed on `Symbol`.
 */
export function disposerMember(): string {
  return `private _neoDisposer(value: unknown): (() => unknown) | undefined {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const target: object = value;
    const legacy: unknown = Reflect.get(target, 'dispose');
    if (typeof legacy === 'function') return () => Reflect.apply(legacy, target, []);
    const symbols = Symbol as SymbolConstructor & { dispose?: symbol; asyncDispose?: symbol };
    for (const key of [symbols.asyncDispose, symbols.dispose]) {
      if (key === undefined) continue;
      const method: unknown = Reflect.get(target, key);
      if (method === undefined || method === null) continue;
      if (typeof method !== 'function') throw new TypeError('disposal protocol must be callable');
      return () => Reflect.apply(method, target, []);
    }
    return undefined;
  }`;
}

/**
 * True when the container calls `_neoDisposer`: an async container (the rollback of a failed initialization) or a
 * graph with a slot that may hold a symbol disposer. A graph of `dispose()` classes names no symbol.
 */
export function needsDisposer(graph: DependencyGraph, hasAsync: boolean): boolean {
  if (hasAsync) return true;
  for (const node of graph.nodes.values()) {
    if (slotKind(node.service) === 'guarded') return true;
  }
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) {
      if (nodes.some((node) => slotKind(node.service) === 'guarded')) return true;
    }
  }
  return false;
}

/**
 * `[Symbol.asyncDispose]` of a container and of a scope: it delegates to `destroy()`, so that both are `await using`
 * resources. A member of the class, not a statement after it: an unread container stays a pure declaration (T14). The key
 * reads `Symbol` through a cast, so the output type-checks without the disposable lib (es2021, docs/release/compatibility.md,
 * "Floor of the emitted code"); with the lib the class also has the typed member. Nothing is installed on `Symbol`, no
 * `Symbol.for` stands in. Known limit: `as symbol` asserts an invariant a runtime without `Symbol.asyncDispose` breaks. The key
 * is `undefined` there and the delegate sits under the string key "undefined", not the protocol (T21 step 4 asks for no
 * member). Accepted for T14: a conditional install is a statement a bundler keeps. T21-P11 pins that key.
 */
export function asyncDisposalMember(): string {
  return `[(Symbol as SymbolConstructor & { asyncDispose?: symbol }).asyncDispose as symbol](): Promise<void> {
    return this.destroy();
  }`;
}

/**
 * The type of `[Symbol.asyncDispose]`, merged into the container class so that `createScope()` and the container itself are
 * `await using` resources for a consumer whose lib declares the symbol (the conditional of `AsyncDisposalMembers` in
 * packages/neosyringe/src/types.ts). For any other lib the conditional is an empty object type: no member, and no global
 * type of the disposable lib is named. Types leave no code behind.
 */
export function asyncDisposalTypes(className: string): string {
  return `type ${className}AsyncDisposal = SymbolConstructor extends { readonly asyncDispose: infer K extends symbol } ? { [P in K]: () => Promise<void> } : Record<never, never>;
interface ${className} extends ${className}AsyncDisposal {}`;
}

/** Returns true if any node in the graph has an async factory. */
export function hasAsyncFactories(graph: DependencyGraph): boolean {
  for (const node of graph.nodes.values()) {
    if (node.service.isAsync) return true;
  }
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) {
      if (nodes.some((node) => node.service.isAsync)) return true;
    }
  }
  return false;
}

/** Returns true if any singleton in the graph has an async disposable implementation. */
export function hasAsyncDisposables(graph: DependencyGraph, sorted: TokenId[]): boolean {
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (node?.service.isAsyncDisposable && node.service.lifecycle === 'singleton') return true;
  }
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) {
      if (nodes.some((node) => node.service.isAsyncDisposable && node.service.lifecycle === 'singleton')) return true;
    }
  }
  return false;
}

interface OrderedStep {
  id: string;
  line: string;
}

/**
 * Ready steps leave in initial-index order. A constraint cycle is not a
 * service cycle: the steps that never become ready keep their source order.
 */
export function stableOrder<T extends { id: string }>(
  steps: readonly T[],
  before: ReadonlyMap<string, ReadonlySet<string>>,
  stats?: { visits: number; heapOps: number; comparisons: number },
): T[] {
  const visit = (): void => {
    if (stats) stats.visits += 1;
  };
  const heapOp = (): void => {
    if (stats) stats.heapOps += 1;
  };
  const ranks = new Map<string, number>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step || ranks.has(step.id)) throw new Error('duplicate step id');
    ranks.set(step.id, index);
  }
  const pending = Array.from({ length: steps.length }, () => 0);
  const successors: number[][] = [];
  for (let index = 0; index < steps.length; index += 1) successors.push([]);
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) continue;
    visit();
    for (const predecessor of before.get(step.id) ?? []) {
      visit();
      const rank = ranks.get(predecessor);
      if (rank === undefined) continue;
      pending[index] = (pending[index] ?? 0) + 1;
      successors[rank]?.push(index);
    }
  }
  const ready = new MinIndexQueue(stats);
  for (let index = 0; index < pending.length; index += 1) {
    if ((pending[index] ?? 0) === 0) {
      ready.push(index);
      heapOp();
    }
  }
  const emitted = new Set<number>();
  const result: T[] = [];
  while (ready.size > 0) {
    const index = ready.pop();
    heapOp();
    emitted.add(index);
    const step = steps[index];
    if (step) result.push(step);
    visit();
    for (const next of successors[index] ?? []) {
      visit();
      const count = (pending[next] ?? 0) - 1;
      pending[next] = count;
      if (count === 0) {
        ready.push(next);
        heapOp();
      }
    }
  }
  steps.forEach((step, index) => {
    if (!emitted.has(index)) result.push(step);
  });
  return result;
}

function collectMultiAsyncLines(
  graph: DependencyGraph,
  getImport: GetImport,
  add: (id: string, line: string) => void,
  multiIds: Map<string, string[]>,
  observation = false,
): void {
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    const ids: string[] = [];
    nodes.forEach((node, index) => {
      if (!node.service.isAsync || node.service.lifecycle !== 'singleton') return;
      const id = `multi:${tokenId}:${index}`;
      const key = multiRegistrationKey(node, tokenId, index);
      const factoryId = `${getFactoryName(tokenId)}_${index}`;
      add(id, `{ ${observedStep(observation, id, `const __neoValue = await this.${factoryId}(); ${afterStore('__neoValue', key, true, isBorrowedInstance(node.service))}`)} }`);
      ids.push(id);
    });
    multiIds.set(tokenId, ids);
  }
}

function linkAsyncConsumers(
  graph: DependencyGraph,
  multiIds: Map<string, string[]>,
  needs: (id: string, pred: string) => void,
): void {
  for (const [tokenId, node] of graph.nodes) {
    for (const dep of node.service.factoryDependencies ?? []) {
      if (!dep.all) continue;
      for (const pred of multiIds.get(dep.tokenId) ?? []) needs(`node:${tokenId}`, pred);
    }
  }
}

function linkNodeOrder(
  sorted: TokenId[],
  graph: DependencyGraph,
  needs: (id: string, pred: string) => void,
): void {
  const plan = aliasPlanOf(graph);
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    for (const dep of orderingDependencies(plan, node.dependencies)) needs(`node:${tokenId}`, `node:${dep}`);
  }
}

/**
 * The async initialization steps of a graph, in the stable topological order, with the steps each multi token stands
 * for. A step is an async singleton registration or an async singleton multi contribution. A transient one is never a
 * step: the analyzer refuses it, and a hand-built graph that has one gets none.
 */
function asyncSteps(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  minimal: boolean,
  observation = false,
): OrderedStep[] {
  const steps: OrderedStep[] = [];
  const ids = new Set<string>();
  const multiIds = new Map<string, string[]>();
  const add = (id: string, line: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    steps.push({ id, line });
  };

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node?.service.isAsync || node.service.lifecycle !== 'singleton') continue;
    const factoryId = getFactoryName(tokenId);
    const tokenKey = resolveTokenKey(node.service, getImport);
    const create = observedStep(observation, tokenId, `const __neoValue = await this.${factoryId}(); ${afterStore('__neoValue', tokenKey, true, isBorrowedInstance(node.service))}`);
    // The minimal profile has no override table to consult.
    add(`node:${tokenId}`, minimal ? `{ ${create} }` : `if (!this.overrides.has(${tokenKey})) { ${create} }`);
  }

  collectMultiAsyncLines(graph, getImport, add, multiIds, observation);

  const before = new Map<string, Set<string>>();
  const needs = (id: string, pred: string) => {
    if (!ids.has(id) || !ids.has(pred) || id === pred) return;
    const set = before.get(id) ?? new Set<string>();
    set.add(pred);
    before.set(id, set);
  };

  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      nodes.forEach((node, index) => {
        const id = `multi:${tokenId}:${index}`;
        for (const dep of orderingDependencies(aliasPlanOf(graph), node.dependencies)) {
          needs(id, `node:${dep}`);
          for (const pred of multiIds.get(dep) ?? []) needs(id, pred);
        }
      });
    }
  }
  linkNodeOrder(sorted, graph, needs);
  linkAsyncConsumers(graph, multiIds, needs);
  return stableOrder(steps, before);
}

function orderedAsyncLines(graph: DependencyGraph, sorted: TokenId[], getImport: GetImport, minimal = false, observation = false): string[] {
  return asyncSteps(graph, sorted, getImport, minimal, observation).map((step) => step.line);
}

/**
 * One initialization step, observed when the build asks for it (topic 22): `initialize` begins before the step and ends
 * once, when its construct and its store have settled, or with the error that stops it. `registration` is the token id of
 * the graph, or `multi:<id>:<index>` for a contribution.
 */
function observedStep(observation: boolean, registration: string, step: string): string {
  if (!observation) return step;
  return `const __neoOp = ${observeBegin('initialize', registration)}; try { ${step} __neoOp('ok'); } catch (__neoThrown) { __neoOp('error', __neoThrown); throw __neoThrown; }`;
}

/** One initialization step as the scheduler runs it: the ranks of the steps it waits for, and the step itself. */
interface InitJob {
  id: string;
  deps: number[];
  line: string;
}

/**
 * The concurrent initialization of a graph: the jobs in the order a sequential initialization would run them (the
 * rank of a job is its priority), and how many may run at once. `undefined` when the initialization is sequential: no
 * concurrency, a concurrency of 1, or fewer than two steps (the number of jobs bounds the concurrency, so one job has
 * nothing to run beside).
 *
 * A job waits for every step its registration reaches through registrations that are not steps: a sync factory or class,
 * a multi token read with `resolveAll`, an alias (read as its target). Those are built while the step runs, so what they
 * read must exist by then. The walk stops at a step, and a step is waited for as a whole.
 *
 * An opaque registration (no `dependencies` list) declares nothing, so what it reads is unknown. A job whose registration,
 * or any registration its walk reaches that is not a step, is opaque waits for every job of a lower rank. A job of a higher
 * rank keeps the dependencies it computed: they include the opaque job when its walk reaches it. Only the nearest lower
 * such job and the ranks after it are written, because that job already waits for every rank below it: the number of
 * dependencies written stays linear in the number of jobs.
 *
 * @throws Error if the jobs wait for each other: a cycle the service graph does not show (a multi contribution a
 * registration reads, which reads that registration). It is refused here, before any effect.
 */
export function initializationJobs(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  minimal = false,
  observation = false,
): { limit: number; jobs: InitJob[] } | undefined {
  const requested = graph.initializationConcurrency ?? 1;
  if (requested <= 1) return undefined;
  const steps = asyncSteps(graph, sorted, getImport, minimal, observation);
  if (steps.length < 2) return undefined;
  const ranks = new Map(steps.map((step, index) => [step.id, index]));
  const plan = aliasPlanOf(graph);
  const reached = new Map<string, ReadonlySet<number>>();
  /** Stands in a set of ranks for "every job of a lower rank": a registration the walk reached is opaque. */
  const UNKNOWN = -1;

  /** The steps `dependencies` need: the step itself, or what the registration that is not a step needs. */
  const needed = (dependencies: readonly TokenId[], visiting: Set<string>): Set<number> => {
    const found = new Set<number>();
    const visit = (id: string, node: DependencyNode): void => {
      const rank = ranks.get(id);
      if (rank !== undefined) {
        found.add(rank);
        return;
      }
      const known = reached.get(id);
      if (known !== undefined) {
        for (const item of known) found.add(item);
        return;
      }
      // A cycle through registrations that are not steps is a service cycle: the analyzer refuses it.
      if (visiting.has(id)) return;
      visiting.add(id);
      const inner = needed(node.dependencies, visiting);
      if (node.service.opaque === true) inner.add(UNKNOWN);
      visiting.delete(id);
      reached.set(id, inner);
      for (const item of inner) found.add(item);
    };
    for (const dependency of orderingDependencies(plan, dependencies)) {
      const single = graph.nodes.get(dependency);
      if (single) visit(`node:${dependency}`, single);
      graph.multiNodes?.get(dependency)?.forEach((node, index) => visit(`multi:${dependency}:${index}`, node));
    }
    return found;
  };

  const own = new Map<string, DependencyNode>();
  for (const [tokenId, node] of graph.nodes) own.set(`node:${tokenId}`, node);
  for (const [tokenId, nodes] of graph.multiNodes ?? []) nodes.forEach((node, index) => own.set(`multi:${tokenId}:${index}`, node));

  /** The nearest lower job that waits for every job below it: what a later opaque job can lean on. */
  let barrier = -1;
  const jobs: InitJob[] = steps.map((step, rank) => {
    const node = own.get(step.id);
    const found = node ? needed(node.dependencies, new Set([step.id])) : new Set<number>();
    if (node?.service.opaque === true) found.add(UNKNOWN);
    if (found.delete(UNKNOWN)) {
      // Transitive reduction: the previous barrier already waits for every rank below it, so only it and the ranks
      // after it are written. A graph of opaque jobs writes one dependency per job, not one per lower rank.
      for (let lower = Math.max(barrier, 0); lower < rank; lower += 1) found.add(lower);
      barrier = rank;
    }
    const deps = [...found].sort((left, right) => left - right);
    return { id: step.id, deps, line: step.line };
  });
  assertAcyclicJobs(jobs);
  return { limit: Math.min(requested, jobs.length), jobs };
}

/**
 * Refuses jobs that wait for each other, naming the jobs that never become ready. A rank outside the list would be a job
 * that never finishes, so it is refused the same way: the ranks come from the list itself, and none is out of it today.
 */
function assertAcyclicJobs(jobs: readonly InitJob[]): void {
  const pending = jobs.map((job) => job.deps.length);
  const followers: number[][] = jobs.map(() => []);
  jobs.forEach((job, index) => {
    for (const dep of job.deps) followers[dep]?.push(index);
  });
  const queue = pending.flatMap((count, index) => (count === 0 ? [index] : []));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const next of followers[queue[cursor] ?? 0] ?? []) {
      pending[next] = (pending[next] ?? 1) - 1;
      if (pending[next] === 0) queue.push(next);
    }
  }
  if (queue.length === jobs.length) return;
  const stuck = jobs.filter((_, index) => !queue.includes(index)).map((job) => job.id);
  throw new Error(`[Generator] Cycle detected between initialization steps: ${stuck.join(', ')}. Validate the graph before calling generate().`);
}

/**
 * `__neoRunJobs`, the member of a container that runs its initialization steps with a bound. It is emitted only for
 * a graph that has a concurrency above 1 and at least two steps ({@link initializationJobs}), so a sequential container
 * pays nothing for it. The jobs come in the order of priority (the index of a job), each with the indexes of the jobs it
 * waits for; the compiler has checked that they form no cycle, so the member trusts them.
 *
 * - At most `limit` jobs run at once, and a job starts when every job it waits for has finished.
 * - The ready jobs leave in index order, from an integer min-heap of about fifteen lines. A runtime cannot import the
 *   compile-time queue (`MinIndexQueue`, minHeap.ts), so the heap is written here; a test pins that both pop the same.
 * - One progress callback (`wake`) is armed per wait. A job that finishes calls it, so the wait is one reaction on a
 *   fresh promise per finished job and never one more reaction on a slow job still pending (`Promise.race(active)` of
 *   every iteration would add one per short job).
 * - After the first failure no job starts. The jobs already started are waited for, then the failure is thrown: the
 *   same object when it is the only one, an `AggregateError` whose `cause` is the first when there are several.
 *   The rollback of the container follows, as for a sequential initialization.
 * - Cancellation (topic 19): once the signal of the caller has aborted, or `destroy()` has begun, no job starts, and the
 *   jobs already started are waited for as after a failure. A destroy that skips jobs does not make the initialization
 *   fail: the call without options resolves, as it does for a sequential initialization that destroy cuts short. When no job failed, the abort reason is thrown after the join (`_neoCheck`), so the
 *   rollback runs with the late values of those jobs in the journal. The emitted text sets `cause` by
 *   assignment through a local `AggregateError & { cause?: unknown }` assertion, not by the `{ cause }` option: the
 *   emitted code is checked against the es2021 lib, which has no `ErrorOptions`, and an es2021 runtime ignores a third
 *   argument. The assertion only widens the type, and `cause` is an own enumerable property, unlike the native option.
 */
export function initSchedulerMember(): string {
  return `private async __neoRunJobs(jobs: ReadonlyArray<{ deps: readonly number[]; run: () => Promise<void> }>, limit: number): Promise<void> {
    const pending: number[] = jobs.map((job) => job.deps.length);
    const followers: number[][] = jobs.map(() => []);
    jobs.forEach((job, index) => { for (const dep of job.deps) followers[dep]?.push(index); });
    const ready: number[] = [];
    const push = (value: number): void => {
      let at = ready.length;
      ready.push(value);
      for (let up = (at - 1) >> 1; at > 0 && (ready[up] ?? 0) > value; up = (at - 1) >> 1) { ready[at] = ready[up] ?? 0; at = up; }
      ready[at] = value;
    };
    const pop = (): number => {
      const first = ready[0] ?? 0;
      const last = ready.pop() ?? 0;
      if (ready.length === 0) return first;
      let at = 0;
      for (let child = 1; child < ready.length; child = at * 2 + 1) {
        if (child + 1 < ready.length && (ready[child + 1] ?? 0) < (ready[child] ?? 0)) child += 1;
        if (last <= (ready[child] ?? 0)) break;
        ready[at] = ready[child] ?? 0;
        at = child;
      }
      ready[at] = last;
      return first;
    };
    pending.forEach((count, index) => { if (count === 0) push(index); });
    const failures: unknown[] = [];
    let active = 0;
    let wake: (() => void) | undefined;
    const start = (index: number): void => {
      active += 1;
      const run = jobs[index]?.run;
      void (run ? run() : Promise.resolve()).then(() => {
        for (const next of followers[index] ?? []) {
          pending[next] = (pending[next] ?? 1) - 1;
          if (pending[next] === 0) push(next);
        }
      }, (failure: unknown) => { failures.push(failure); }).then(() => {
        active -= 1;
        const notify = wake;
        wake = undefined;
        notify?.();
      });
    };
    while (ready.length > 0 || active > 0) {
      while (failures.length === 0 && this._initCancel === undefined && this._state !== 'destroying' && ready.length > 0 && active < limit) start(pop());
      if (active === 0) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      const aggregate = new AggregateError(failures, 'initialization failed') as AggregateError & { cause?: unknown };
      aggregate.cause = failures[0];
      throw aggregate;
    }
    this._neoCheck();
  }`;
}

/** The statement that runs the jobs of {@link initializationJobs}: parents are checked once more, then the jobs start. */
function runJobsLines(plan: { limit: number; jobs: InitJob[] }): string[] {
  const jobs = plan.jobs.map((job) => `        { deps: [${job.deps.join(', ')}], run: async () => { ${job.line} } },`);
  return ['this._assertParents();', `await this.__neoRunJobs([\n${jobs.join('\n')}\n      ], ${plan.limit});`];
}

/**
 * Cancellation (topic 19). The method is not `async`, so a join answers the very promise the first call answered. Two
 * promises are kept: `_initWork` ends when the initialization really ends (the factories that run have returned and the
 * rollback is done; `destroy()` waits on it), `_initObserved` is what the caller waits on, and it rejects earlier, with
 * `signal.reason`, when the signal of the caller aborts. A step checks the signal of the caller before it starts
 * (`_neoCheck`), so a late value of a factory that ignored the signal is stored and journaled by the step that
 * produced it, and the rollback closes it. `destroy()` aborts the signal the factories see. A sequential initialization
 * does not stop on a destroy: its steps still run and are closed with the rest, as before. A concurrent one starts no
 * queued job once the container is destroying (`__neoRunJobs`). The listener on the caller's signal is removed when the
 * work settles.
 *
 * About `(this._state as string)` below: the cleanup awaits a dispose, and destroy() may set 'destroying'
 * in the meantime. The check above that threw on 'destroying' narrows the property for the compiler, which
 * does not follow state across an await. The assertion widens it back; it adds no runtime code.
 *
 * Generates the initialize() method that pre-creates all async singleton factories
 * in topological order. Called whenever this container OR its useContainer
 * parent/legacy chain has async factories (see DependencyGraph.parentHasAsyncInitialize) —
 * a container with none of its own still needs to exist here purely to cascade
 * into a parent that does, rather than leaving that sequencing to the caller.
 */
export function generateInitializeMethod(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync: boolean,
  eagerLines: string[] = [],
  minimal = false,
  className = 'NeoContainer',
  observation = false,
): string {
  if (!hasAsync) return generateSyncInitializeMethod(minimal, boundInitializeGuard(graph));

  const signal = signalTypeName(className);
  const lines: string[] = [];

  // Nothing starts once the caller has cancelled: not the parents' initialization, not a factory.
  lines.push('this._neoCheck();');
  // Cascade first: a local async factory may itself resolve() a parent-provided
  // singleton, so the parent/legacy chain must be ready before we create ours.
  // Guarded at runtime (not statically) so this also covers declareContainerTokens
  // legacy adapters we can't analyze — if one happens to expose its own
  // initialize(), it still gets awaited; if not, this is a harmless no-op.
  lines.push(
    `if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }`
  );
  // A bounded concurrency above 1 runs the steps as jobs; the default writes the sequential lines it always did. The
  // sequential lines check the signal before each step and once after the last; the scheduler checks before each job
  // it starts and after the join.
  const plan = initializationJobs(graph, sorted, getImport, minimal, observation);
  if (plan) {
    lines.push('this._neoCheck();', ...runJobsLines(plan));
  } else {
    for (const line of orderedAsyncLines(graph, sorted, getImport, minimal, observation)) lines.push('this._neoCheck();', line);
    lines.push('this._neoCheck();');
  }
  lines.push(...eagerLines);

  // Joining the in-flight promise from a sync factory still on the stack deadlocks. Only the busy states refuse.
  // `initialize` is not `async`: a join answers the very promise the first call answered (`_initObserved`).
  const initializeOutput = `public initialize(options?: { readonly signal?: ${signal} }): Promise<void> {
    ${boundInitializeGuard(graph)}if ((this._state === 'initializing' || this._state === 'cancelling') && this._syncInit > 0) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    const __neoUser = options?.signal;
    if (this._state === 'initializing' || this._state === 'cancelling') {
      if (__neoUser !== undefined && __neoUser !== this._initSignal) return Promise.reject(this._neoFail('NEO_INIT_OPTIONS_CONFLICT', 'initialize() is running with another signal'));
      return this._initObserved;
    }
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    }
    ${minimal ? '' : "if (this._state === 'reconfiguring') return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));"}
    if (__neoUser !== undefined && (__neoUser === null || typeof __neoUser.addEventListener !== 'function' || typeof __neoUser.removeEventListener !== 'function')) return Promise.reject(new TypeError('initialize() needs an AbortSignal in options.signal'));
    return this._startInitialize(__neoUser);
  }

  private _startInitialize(__neoUser: ${signal} | undefined): Promise<void> {
    this._state = 'initializing';
    const __neoController = ${className}.__neoController();
    this._initController = __neoController;
    this._initSignal = __neoUser;
    this._initCancel = undefined;
    let __neoResolve: () => void = () => {};
    let __neoReject: (reason: unknown) => void = () => {};
    const __neoObserved = new Promise<void>((resolve, reject) => {
      __neoResolve = resolve;
      __neoReject = reject;
    });
    this._initObserved = __neoObserved;
    const __neoRelay = (): void => {
      ${observation ? 'this._neoObs().cancelled();\n      ' : ''}const __neoReason: unknown = __neoUser?.reason;
      this._initCancel = { reason: __neoReason };
      if (this._state === 'initializing') this._state = 'cancelling';
      __neoReject(__neoReason);
      __neoController.abort(__neoReason);
    };
    if (__neoUser !== undefined) {
      if (__neoUser.aborted) __neoRelay();
      else __neoUser.addEventListener('abort', __neoRelay, { once: true });
    }
    const __neoWork = this._runInitialize();
    this._initWork = __neoWork;
    const __neoSettle = (): void => {
      __neoUser?.removeEventListener('abort', __neoRelay);
      if (this._initController === __neoController) {
        this._initController = undefined;
        this._initSignal = undefined;
      }
    };
    void __neoWork.then(
      () => { __neoSettle(); __neoResolve(); },
      (__neoError: unknown) => { __neoSettle(); __neoReject(__neoError); },
    );
    return __neoObserved;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      ${lines.join('\n      ')}
      if (this._state === 'initializing') this._state = 'ready';
    } catch (__neoInitError) {
      this._failure = __neoInitError;
      if (this._state === 'destroying') throw __neoInitError;
      const __neoCleanup: unknown[] = [];
      const __neoSeen = new Set();
      for (const __neoKey of [...this._initJournal].reverse()) {
        const __neoInst = this.instances.get(__neoKey) as ${MAYBE_DISPOSABLE};
        this.instances.delete(__neoKey);
        if (__neoInst == null || this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)) continue;
        __neoSeen.add(__neoInst);
        try {
          const __neoRun = this._neoDisposer(__neoInst);
          if (__neoRun) {
            ${observation ? observedDisposal(`this._neoRegistration(__neoKey)`, '__neoRun()') : 'const __neoResult = __neoRun();'}
            if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') await __neoResult;
          }
        } catch (__neoDisposeError) {
          __neoCleanup.push(__neoDisposeError);
        }
      }
      if (__neoCleanup.length === 0) {
        if ((this._state as string) !== 'destroying') this._state = 'failed';
        throw __neoInitError;
      }
      const __neoWrapped = new Error(__neoInitError instanceof Error ? __neoInitError.message : String(__neoInitError)) as Error & { cause?: unknown; cleanupErrors?: unknown[] };
      __neoWrapped.cause = __neoInitError;
      __neoWrapped.cleanupErrors = __neoCleanup;
      this._failure = __neoWrapped;
      if ((this._state as string) !== 'destroying') this._state = 'failed';
      throw __neoWrapped;
    } finally {
      this._initRunning = false;
    }
  }

  private _guardPublic(op: string = 'resolve()'): void {
    if (this._state === 'created' || this._state === 'initializing' || this._state === 'cancelling') {
      throw this._neoFail('NEO_NOT_INITIALIZED', 'call await container.initialize() before ' + op);
    }
    ${minimal ? '' : `if (this._state === 'reconfiguring') {
      throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
    }
    `}if (this._state === 'failed') {
      throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure);
    }
    if (this._state === 'destroying' || this._state === 'destroyed') {
      throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
    }
  }

  private _neoFail(code: string, detail: string, cause?: unknown): Error {
    const error = new Error(code + ': [' + this.name + '] ' + detail) as Error & { code: string; cause?: unknown };
    error.code = code;
    if (arguments.length >= 3) error.cause = cause;
    return error;
  }`;
  return observation ? `${initializeOutput}\n\n  ${registrationMember(graph, getImport)}` : initializeOutput;
}

/**
 * One disposal, observed (topic 22): `dispose` begins before the disposer runs and ends once, with the settlement of a
 * promise it returns or the error it throws. `registration` is the text of the expression that says which registration it
 * is; `call` the text of the call. The statements leave `__neoResult` for the code that follows, as the plain call does.
 */
function observedDisposal(registration: string, call: string): string {
  return `const __neoOp = this._neoObs().begin('dispose', this._scopeId, ${registration}); let __neoResult: unknown; try { __neoResult = ${call}; __neoResult = this._neoSettle(__neoOp, __neoResult); } catch (__neoThrown) { __neoOp('error', __neoThrown); throw __neoThrown; }`;
}

/**
 * The rollback of a failed initialization closes the values the journal keeps, by their cache key: the registration is
 * found from the key, in the order of the graph, so the dispose events of a rollback carry the ids of the other events.
 */
function registrationMember(graph: DependencyGraph, getImport: GetImport): string {
  const rows: string[] = [];
  for (const [tokenId, node] of graph.nodes) {
    if (node.service.type === 'parent' || node.service.type === 'alias' || node.service.lifecycle === 'transient') continue;
    rows.push(`if (key === ${resolveTokenKey(node.service, getImport)}) return ${JSON.stringify(tokenId)};`);
  }
  for (const [tokenId, nodes] of graph.multiNodes ?? []) {
    nodes.forEach((node, index) => {
      if (node.service.lifecycle === 'transient') return;
      rows.push(`if (key === ${multiRegistrationKey(node, tokenId, index)}) return ${JSON.stringify(`multi:${tokenId}:${index}`)};`);
    });
  }
  return `private _neoRegistration(key: unknown): string {
    ${rows.join('\n    ')}
    return '';
  }`;
}

/**
 * What a sync `initialize` reads of its options: whether the signal has aborted, and why. A sync container has nothing to
 * cancel while it runs, so an aborted signal refuses the call before any eager line, and the container is left as it was.
 * The shape is written inline: a sync class has no signal alias unless one of its factories reads a context.
 */
const SYNC_OPTIONS = '{ readonly signal?: { readonly aborted: boolean; readonly reason?: unknown } }';

/**
 * Sync containers still expose initialize(). It is not `async` and it does not
 * touch `_initialized`: those shapes belong to containers that have async work.
 */
export function generateSyncInitializeMethod(minimal = false, bound = ''): string {
  return `public initialize(options?: ${SYNC_OPTIONS}): Promise<void> {
    ${bound}if (this._touchClosed(false)) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    ${minimal ? '' : "if (this._reconfiguring) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));"}
    if (this._failure !== undefined) return Promise.reject(this._failure);
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    return Promise.resolve();
  }`;
}

/** Sync eager roots run once. A second initialize() is a no-op. ADR006 line 12. */
export function generateEagerSyncInitialize(lines: string[], minimal = false, bound = ''): string {
  return `public initialize(options?: ${SYNC_OPTIONS}): Promise<void> {
    ${bound}if (this._eagerOnce) return Promise.resolve();
    if (this._touchClosed(false)) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    ${minimal ? '' : "if (this._reconfiguring) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));"}
    if (this._failure !== undefined) return Promise.reject(this._failure);
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    this._eagerOnce = true;
    ${lines.join('\n    ')}
    return Promise.resolve();
  }`;
}

/** The state checks every `createScope` makes before it builds a scope, whatever the scope is given. */
function createScopeGuard(hasAsync: boolean, minimal: boolean): string {
  return hasAsync
    ? `if (this._state === 'destroying' || this._state === 'destroyed' || this._touchClosed(false)) {
    throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
  }
  if (this._state === 'failed') {
    throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed');
  }
  if (this._state === 'initializing' || this._state === 'cancelling'${minimal ? '' : " || this._state === 'reconfiguring'"}) {
    throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
  }`
    : `${minimal ? '' : `if (this._reconfiguring) {
    throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
  }
  `}if (this._failure !== undefined) {
    throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure);
  }
  if (this._touchClosed(false)) {
    throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
  }`;
}

/** A scope shares the parent list and the name. It does not copy caches or call initialize(). */
export function generateCreateScopeMethod(className: string, hasAsync: boolean, minimal = false, observation = false): string {
  const build = observation
    ? `const __neoScope = new ${className}(this.legacy, this.name);
    this._neoAdopt(__neoScope);
    return __neoScope;`
    : `return new ${className}(this.legacy, this.name);`;
  return `public createScope(): ${className} {
    ${createScopeGuard(hasAsync, minimal)}
    ${build}
  }`;
}

/**
 * `createScope` of a container: the plain one, or the one that takes the values of its inputs when the graph
 * declares some. The state checks are the same text.
 */
export function generateScopeMethod(graph: DependencyGraph, className: string, hasAsync: boolean, minimal = false, observation = false): string {
  return hasScopeInputs(graph)
    ? inputCreateScopeMethod(className, createScopeGuard(hasAsync, minimal), observation)
    : generateCreateScopeMethod(className, hasAsync, minimal, observation);
}

/**
 * Destroy and resolve share this helper so one edit changes both sides. Observed (topic 22), the first mark of a scope
 * releases it from the count of the scopes in use: `_closed` is the one place that says a container is closed.
 */
export function touchClosedMethod(observation = false): string {
  if (observation) {
    return `private _touchClosed(mark: boolean): boolean {
    if (mark) {
      if (!this._closed && this._scoped) this._obs?.scopeClosed();
      this._closed = true;
    }
    return this._closed;
  }`;
  }
  return `private _touchClosed(mark: boolean): boolean {
    if (mark) this._closed = true;
    return this._closed;
  }`;
}

export function assertParentsMethod(): string {
  return `private _assertParents(): void {
    if (!this.legacy) return;
    for (const legacyContainer of this.legacy) {
      if (legacyContainer && (legacyContainer as ${LEGACY_STATE})._closed) {
        throw this._neoFail('NEO_SCOPE_PARENT_DESTROYED', 'parent is destroyed: ' + (legacyContainer as ${LEGACY_STATE}).name);
      }
    }
  }`;
}

/** Sync output has no initialize() block, so it needs its own error helper. */
export function syncNeoFailMethod(): string {
  return `private _neoFail(code: string, detail: string, cause?: unknown): Error {
    const error = new Error(code + ': [' + this.name + '] ' + detail) as Error & { code: string; cause?: unknown };
    error.code = code;
    if (arguments.length >= 3) error.cause = cause;
    return error;
  }`;
}

function destroyJoinPrefix(): string {
  return `if (this._destroyWork) return this._destroyWork;
    if (this._touchClosed(false)) return Promise.resolve();`;
}

interface DisposalSlot {
  id: string;
  tokenKey: string;
  isAsync: boolean;
  guarded: boolean;
  late: boolean;
}

function linkContributionDependencies(
  graph: DependencyGraph,
  edge: (first: string, later: string) => void,
): void {
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const id = `multi:${tokenId}:${index}`;
      for (const dep of orderingDependencies(aliasPlanOf(graph), node.dependencies)) edge(id, `node:${dep}`);
    });
  }
}

function linkNodeDisposal(
  graph: DependencyGraph,
  sorted: TokenId[],
  edge: (first: string, later: string) => void,
): void {
  const plan = aliasPlanOf(graph);
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    for (const dep of orderingDependencies(plan, node.dependencies)) edge(`node:${tokenId}`, `node:${dep}`);
  }
}

function slotKind(service: ServiceDefinition): 'skip' | 'unguarded' | 'guarded' {
  if (service.lifecycle === 'transient' || service.type === 'parent') return 'skip';
  if (isBorrowedInstance(service)) return 'skip';
  if (service.symbolDisposer) return 'guarded';
  if (service.isDisposable || service.isAsyncDisposable) return 'unguarded';
  if (service.type === 'factory') return 'guarded';
  return 'skip';
}

function combinedDisposals(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
): { slots: DisposalSlot[]; awaitClose: boolean } {
  const slots: DisposalSlot[] = [];
  const seen = new Set<string>();
  const add = (id: string, service: ServiceDefinition, tokenKey: string, kind: 'unguarded' | 'guarded') => {
    if (seen.has(id)) return;
    seen.add(id);
    slots.push({
      id,
      tokenKey,
      isAsync: !!service.isAsyncDisposable,
      guarded: kind === 'guarded',
      late: false,
    });
  };

  for (const tokenId of [...sorted].reverse()) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    const kind = slotKind(node.service);
    if (kind === 'skip') continue;
    add(`node:${tokenId}`, node.service, resolveTokenKey(node.service, getImport), kind);
  }

  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      nodes.forEach((node, index) => {
        const kind = slotKind(node.service);
        if (kind === 'skip') return;
        add(`multi:${tokenId}:${index}`, node.service, multiRegistrationKey(node, tokenId, index), kind);
      });
    }
  }

  slots.sort((left, right) => Number(left.isAsync) - Number(right.isAsync));

  const before = new Map<string, Set<string>>();
  const edge = (first: string, later: string) => {
    if (!seen.has(first) || !seen.has(later) || first === later) return;
    const set = before.get(later) ?? new Set<string>();
    set.add(first);
    before.set(later, set);
  };
  linkContributionDependencies(graph, edge);
  linkNodeDisposal(graph, sorted, edge);
  const ordered = stableOrder(slots, before);

  const blocking = new Set(ordered.filter((slot) => slot.isAsync).map((slot) => slot.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const slot of ordered) {
      if (blocking.has(slot.id)) continue;
      const preds = before.get(slot.id);
      if (preds && [...preds].some((pred) => blocking.has(pred))) {
        blocking.add(slot.id);
        changed = true;
      }
    }
  }
  for (const slot of ordered) slot.late = blocking.has(slot.id);
  // Whatever a disposer returns may be a promise (a `dispose(): void` can return one), so any slot closes asynchronously.
  const awaitClose = ordered.length > 0;
  return { slots: ordered, awaitClose };
}

function disposeCall(slot: DisposalSlot, immediateAwait: boolean, observation = false): string {
  const follow = immediateAwait
    ? `if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') await __neoResult;`
    : `if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') __neoPending.push(__neoResult);`;
  const registration = JSON.stringify(slot.id.startsWith('node:') ? slot.id.slice('node:'.length) : slot.id);
  if (slot.guarded) {
    const run = observation ? observedDisposal(registration, '__neoRun()') : 'const __neoResult = __neoRun();';
    return `const __neoRun = this._neoDisposer(__neoInst); if (__neoRun) { ${run} ${follow} }`;
  }
  const run = observation ? observedDisposal(registration, '__neoInst.dispose()') : 'const __neoResult = __neoInst.dispose();';
  return `${run} ${follow}`;
}

function disposeSlot(slot: DisposalSlot, immediateAwait: boolean, observation = false): string {
  const call = disposeCall(slot, immediateAwait, observation);
  const read = slot.guarded ? MAYBE_DISPOSABLE : DISPOSABLE;
  return `if (this.instances.has(${slot.tokenKey})) { const __neoInst = this.instances.get(${slot.tokenKey}) as ${read}; if (!(__neoInst != null && (this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)))) { if (__neoInst != null) __neoSeen.add(__neoInst); try { ${call} } catch (__neoDisposeError) { __neoErrors.push(__neoDisposeError); } } }`;
}

/**
 * The failures of a disposal are gathered and thrown as one `AggregateError` (lib es2021, docs/release/compatibility.md,
 * "Floor of the emitted code"). A graph with no disposal slot has nothing to gather: no collector, no throw, no name
 * the output's lib must provide.
 */
function sharedDisposalLines(slots: DisposalSlot[], awaitClose: boolean, observation = false): string[] {
  if (slots.length === 0) return ['this.instances.clear();'];
  const lines = ['const __neoSeen = new Set();', 'const __neoErrors: unknown[] = [];'];
  const early = slots.filter((slot) => !slot.late);
  const late = slots.filter((slot) => slot.late);
  const defer = awaitClose && early.length > 0;
  if (defer) lines.push('const __neoPending: unknown[] = [];');
  for (const slot of early) lines.push(disposeSlot(slot, false, observation));
  if (defer) {
    lines.push('for (const __neoPendingItem of __neoPending) { try { await __neoPendingItem; } catch (__neoDisposeError) { __neoErrors.push(__neoDisposeError); } }');
  }
  for (const slot of late) lines.push(disposeSlot(slot, true, observation));
  lines.push('this.instances.clear();');
  return lines;
}

function disposalLines(slots: DisposalSlot[], awaitClose: boolean, minimal = false, observation = false): string[] {
  return [
    ...sharedDisposalLines(slots, awaitClose, observation),
    ...(minimal ? [] : ['this.overrides.clear();', 'this.resolveListeners.clear();']),
    ...(slots.length === 0 ? [] : ['if (__neoErrors.length > 0) { const __neoDisposeFailure = new AggregateError(__neoErrors); throw __neoDisposeFailure; }']),
  ];
}

/** One refusal of the state of a container: the condition, the error and what the error carries. */
interface Gate {
  /** The condition, over `state`: the expression the container's state is read through. */
  when: (state: string) => string;
  code: string;
  detail: string;
  /** The expression of the cause, when the error carries one. */
  cause?: string;
}

/** The text of a gate whose refusal is a rejected promise: `override()` and `clearOverrides()` return it. */
function asReject(gate: Gate): string {
  const cause = gate.cause === undefined ? '' : `, ${gate.cause}`;
  return `if (${gate.when('this._state')}) return Promise.reject(this._neoFail('${gate.code}', '${gate.detail}'${cause}));`;
}

/**
 * The same refusal as a throw: the batch runs inside a try block that turns it into the rejection, from any point of its body.
 * The state is read once into a `string` that the checker cannot narrow. The batch tests its gates twice, and after the
 * first group of throws the checker knows `this._state` is neither of the busy states, so the second group of
 * comparisons would be a TS2367 error in the generated file.
 */
function asThrow(gate: Gate): string {
  const cause = gate.cause === undefined ? '' : `, ${gate.cause}`;
  return `if (${gate.when('__neoState')}) throw this._neoFail('${gate.code}', '${gate.detail}'${cause});`;
}

/**
 * override(), overrideMany() and clearOverrides(). The gate is synchronous.
 * Cleanup finishes before the new override table is applied.
 * A borrowed mock is removed from `_borrowed` and never disposed.
 * overrideMany runs the same gates, the same arm and the same `_reconfigure` as override: one transition for the batch.
 * `names` is undefined for a minimal container (the reference emitter writes these members for every profile): the
 * batch is a member of the full profile only, so nothing of it is emitted.
 */
export function generateOverrideMethods(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync: boolean,
  testOverrides: boolean,
  names: ManyNames | undefined,
  observation = false,
): string {
  const refused = `return Promise.reject(this._neoFail('NEO_TEST_API_DISABLED', 'test overrides are disabled'));`;
  // Disabled: the members refuse and nothing else is emitted. No reconfiguration, no disposal of the cache, no AggregateError.
  if (!testOverrides) {
    return `public override(_token: unknown, _factory: () => unknown): Promise<void> {
    ${refused}
  }

  ${names === undefined ? '' : `public overrideMany(_entries: unknown): Promise<void> {
    ${refused}
  }

  `}public clearOverrides(): Promise<void> {
    ${refused}
  }`;
  }
  const collected = combinedDisposals(graph, sorted, getImport);
  const disposalBody = sharedDisposalLines(collected.slots, collected.awaitClose, observation).join('\n    ');
  // The refusals of the state, in the order the three methods test them: busy, destroyed, failed.
  const gates: Gate[] = [
    {
      when: (state) => hasAsync
        ? `${state} === 'initializing' || ${state} === 'cancelling' || ${state} === 'reconfiguring' || ${state} === 'destroying'`
        : `this._reconfiguring || this._destroyWork`,
      code: 'NEO_CONTAINER_BUSY',
      detail: 'container is transitioning',
    },
    {
      when: (state) => hasAsync ? `${state} === 'destroyed' || this._touchClosed(false)` : `this._touchClosed(false) === true`,
      code: 'NEO_CONTAINER_DESTROYED',
      detail: 'container is destroyed',
    },
    {
      when: (state) => hasAsync ? `${state} === 'failed' || this._failure !== undefined` : `this._failure !== undefined`,
      code: 'NEO_CONTAINER_FAILED',
      detail: 'container initialization failed',
      cause: 'this._failure',
    },
  ];
  const rejectGates = gates.map(asReject).join('\n    ');
  // The batch writes its gates at the indent of its try block (6 spaces); the async form wraps them in a block (8).
  const throwGates = hasAsync
    ? `{\n        const __neoState: string = this._state;\n        ${gates.map(asThrow).join('\n        ')}\n      }`
    : gates.map(asThrow).join('\n      ');
  const arm = hasAsync ? `this._state = 'reconfiguring';` : `this._reconfiguring = true;`;
  const onFailure = hasAsync
    ? `if (this._state === 'reconfiguring') { this._failure = __neoDisposeFailure; this._state = 'failed'; }`
    : `if (this._reconfiguring) { this._failure = __neoDisposeFailure; this._reconfiguring = false; }`;
  const onSuccess = hasAsync
    ? `this._initJournal = []; this._initWork = undefined; this._failure = undefined; this._initRunning = false; this._state = 'created';`
    : `if (this._reconfiguring) { this._failure = undefined; this._reconfiguring = false; }`;
  const stillOpen = hasAsync ? `this._state === 'reconfiguring'` : `this._reconfiguring`;
  const park = hasAsync
    ? `this._failure = __neoReconfigureError; this._state = 'failed';`
    : `this._failure = __neoReconfigureError; this._reconfiguring = false;`;
  const multiGuard = overrideTokenChecks(graph, getImport, 'reject');
  const failureBlock = collected.slots.length === 0
    ? ''
    : `if (__neoErrors.length > 0) {
        const __neoDisposeFailure = new AggregateError(__neoErrors);
        ${onFailure}
        throw __neoDisposeFailure;
      }`;

  const overrideMany = names === undefined
    ? ''
    : `${emitOverrideMany({ gates: throwGates, tokenChecks: overrideTokenChecks(graph, getImport, 'throw'), arm }, names)}\n\n  `;

  return `public override(token: unknown, factory: () => unknown): Promise<void> {
    ${rejectGates}
    ${multiGuard}
    ${arm}
    return this._reconfigure(() => { this.overrides.set(token, factory); });
  }

  public clearOverrides(): Promise<void> {
    ${rejectGates}
    ${arm}
    return this._reconfigure(() => { this.overrides.clear(); });
  }

  ${overrideMany}private async _reconfigure(apply: () => void): Promise<void> {
    const __neoMocks: unknown[] = [];
    for (const __neoToken of this.overrides.keys()) {
      if (this.instances.has(__neoToken)) __neoMocks.push(this.instances.get(__neoToken));
    }
    try {
      ${disposalBody}
      for (const __neoMock of __neoMocks) this._borrowed.delete(__neoMock);
      ${failureBlock}
      apply();
      ${onSuccess}
    } catch (__neoReconfigureError) {
      if (${stillOpen}) {
        ${park}
      }
      throw __neoReconfigureError;
    }
  }`;
}

/**
 * Generates the destroy() method, and `[Symbol.asyncDispose]` that delegates to it.
 * Disposes cached singletons consumer-before-dependency.
 * A graph with no disposal slot keeps a destroy that is not async. Any slot makes destroy close asynchronously inside
 * `_close` or `_runDestroy`, because what a disposer returns, a `dispose(): void` included, may be a promise to await.
 */
export function generateDestroyMethod(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
  minimal = false,
  observation = false,
): string {
  const members = `${destroyMembers(graph, sorted, getImport, hasAsync, minimal, observation)}\n\n  ${asyncDisposalMember()}`;
  return hasScopeInputs(graph) ? `${inputDestroyMethod()}\n\n  ${members}` : members;
}

function destroyMembers(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
  minimal = false,
  observation = false,
): string {
  const collected = combinedDisposals(graph, sorted, getImport);
  const lines = disposalLines(collected.slots, collected.awaitClose, minimal, observation);
  const body = lines.join('\n    ');
  const join = destroyJoinPrefix();
  // A container with inputs releases its values once its destroy is over: its own destroy has another name.
  const inputs = hasScopeInputs(graph);
  const destroyHead = (async: boolean): string => `${inputs ? 'private' : 'public'} ${async ? 'async ' : ''}${inputs ? '_destroyScope' : 'destroy'}(): Promise<void> {`;
  // Observed (topic 22), the container lets go of the sinks it took once its destroy is over, the dispose events included.
  const release = (indent: string): string => (observation ? `${indent}this._neoRelease();` : '');
  const reconfigBusy = minimal
    ? ''
    : `if (${hasAsync ? "this._state === 'reconfiguring'" : "this._reconfiguring"}) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));`;

  if (!hasAsync) {
    if (collected.awaitClose) {
      return `${destroyHead(true)}
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    const __neoRun = this._runDestroy();
    this._destroyWork = __neoRun;
    try {
      await __neoRun;
    } finally {
      this._destroyWork = undefined;${release('\n      ')}
    }
  }

  private async _runDestroy(): Promise<void> {
    ${body}
  }`;
    }

    return `${destroyHead(false)}
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    try {
      ${body}
    } catch (__neoDestroyError) {${release('\n      ')}
      return Promise.reject(__neoDestroyError);
    }${release('\n    ')}
    return Promise.resolve();
  }`;
  }

  const finish = collected.awaitClose ? 'await this._close();' : 'this._close();';
  const closeHead = collected.awaitClose
    ? 'private async _close(): Promise<void> {'
    : 'private _close(): void {';

  return `${destroyHead(false)}
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    if (this._state === 'destroyed') return Promise.resolve();
    if (this._state === 'created') {
      this._state = 'destroyed';${release('\n      ')}
      return Promise.resolve();
    }
    this._state = 'destroying';
    const __neoRun = (async () => {
      if (this._initWork) {
        try { await this._initWork; } catch { /* initialization failure stays on _failure */ }
      }
      try {
        ${finish}
      } finally {
        if (this._state === 'destroying') this._state = 'destroyed';${release('\n        ')}
      }
    })();
    this._destroyWork = __neoRun;
    const __neoClear = () => { if (this._destroyWork === __neoRun) this._destroyWork = undefined; };
    void __neoRun.then(__neoClear, __neoClear);
    // The terminal state and the work are installed: a listener that calls destroy() or resolve() sees both.
    this._initController?.abort(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    return __neoRun;
  }

  ${closeHead}
    ${body}
  }`;
}
