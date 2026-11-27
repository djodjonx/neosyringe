/**
 * Independent model of the composition of the stage F features: scope inputs (topic 18), an alias (topic 20),
 * `resolveMany` (topic 17), a bounded concurrent initialization (topic 11), a `useContainer` parent and the disposal of
 * a scope (topics 06 and 21). It does not import the generator and it does not copy its branches: it is written from
 * the rules of the topics, one rule per `if`, over a service table the test owns.
 *
 * What the model knows about the graph (the table `SERVICES`):
 * - `Base` is a class of the PARENT container: the parent builds it once, whoever asks, and disposes it with itself.
 * - `A` (reads `Req` and `Base`), `B` (reads `A` and `Lim`) and `E` (reads `Lim`) are classes of the scope, built on
 *   demand and cached for the life of the scope.
 * - `c` and `d` are ASYNC factories (`d` reads `B`): `initialize()` builds them and, through `d`, `B` and `A`.
 * - `twin` is an alias of `B`: it answers the instance of `B`.
 * Every value carries a `tag` that spells the inputs it was built from, so a value that crossed from one scope to
 * another, or that ignored an input, shows in the trace.
 */

export type Token = 'c' | 'd' | 'twin' | 'A' | 'B' | 'E' | 'Base';
export type Binding = 'one' | 'two' | 'missing';

/** A public call made on a scope while its initialization is in flight (state Initializing of docs/guide/states-and-ownership.md). */
export type DuringProbe =
  | { readonly kind: 'resolve'; readonly token: Token }
  | { readonly kind: 'resolveMany'; readonly tokens: readonly Token[] }
  | { readonly kind: 'createScope'; readonly binding: Binding };

/** The operation a probe stands for, on the scope that is initializing. */
export function probeAsOp(scope: number, probe: DuringProbe): CompositionOp {
  if (probe.kind === 'resolve') return { kind: 'resolve', scope, token: probe.token };
  if (probe.kind === 'resolveMany') return { kind: 'resolveMany', scope, tokens: probe.tokens };
  return { kind: 'createScope', from: scope, binding: probe.binding };
}

/** The name of the event a probe makes. */
export function describeProbe(scope: number, probe: DuringProbe): string {
  return `${describeOp(probeAsOp(scope, probe))} while ${scope} is initializing`;
}

export type CompositionOp =
  /** `resolve` on the container that was not given its inputs. */
  | { readonly kind: 'resolveUnbound'; readonly token: Token }
  /** `createScope` from the container (`from` 0) or from a scope made earlier. */
  | { readonly kind: 'createScope'; readonly from: number; readonly binding: Binding }
  /**
   * `held`: the factories wait for the test, which reads how many ran at once before it lets them go. `during` are public
   * calls made on that scope while the initialization is in flight, in this order, before the factories are let go.
   */
  | { readonly kind: 'initialize'; readonly scope: number; readonly held?: boolean; readonly during?: readonly DuringProbe[] }
  | { readonly kind: 'resolve'; readonly scope: number; readonly token: Token }
  | { readonly kind: 'resolveMany'; readonly scope: number; readonly tokens: readonly Token[] }
  | { readonly kind: 'destroy'; readonly scope: number }
  | { readonly kind: 'destroyParent' };

export interface CompositionScenario {
  readonly ops: readonly CompositionOp[];
  readonly mode: 'open' | 'closed';
  /** `initialization.concurrency` of the container. */
  readonly concurrency: number;
}

/** What one operation did: its answer, and which services it built and disposed (sorted: the order is not part of it). */
export interface CompositionEvent {
  readonly op: string;
  readonly code: string;
  readonly value: string;
  readonly delivery: 'value' | 'sync' | 'reject';
  readonly built: readonly string[];
  readonly disposed: readonly string[];
  /** A held initialization: how many factories ran at once. Any other operation: -1. */
  readonly running: number;
}

export interface CompositionTrace {
  readonly events: readonly CompositionEvent[];
  readonly constructs: Readonly<Record<string, number>>;
  readonly disposals: Readonly<Record<string, number>>;
}

/** The two values each binding gives the inputs, `Req.id` and `Lim.n`. */
export const BINDINGS: Readonly<Record<'one' | 'two', { readonly id: string; readonly n: number }>> = {
  one: { id: 'r1', n: 2 },
  two: { id: 'r2', n: 5 },
};

interface Service {
  readonly name: string;
  /** The names it reads, `Req` and `Lim` being inputs. */
  readonly deps: readonly string[];
  readonly async: boolean;
}

const SERVICES: readonly Service[] = [
  { name: 'A', deps: ['Req', 'Base'], async: false },
  { name: 'B', deps: ['A', 'Lim'], async: false },
  { name: 'E', deps: ['Lim'], async: false },
  { name: 'c', deps: [], async: true },
  { name: 'd', deps: ['B'], async: true },
];

/** The roots of a closed container: every service the scope owns but `A`, the alias `twin` included. */
const CLOSED_ROOTS: ReadonlySet<string> = new Set(['c', 'd', 'twin', 'B', 'E']);

/** The services a graph with this table disposes, consumer before dependency: `[consumer, dependency]`. */
export function disposalPairs(): ReadonlyArray<readonly [string, string]> {
  const owned = new Set(SERVICES.map((service) => service.name));
  return SERVICES.flatMap((service) => service.deps.filter((dep) => owned.has(dep)).map((dep): readonly [string, string] => [service.name, dep]));
}

/** The construction order the table forces: a dependency is built before its consumer, `[dependency, consumer]`. */
export function constructionPairs(): ReadonlyArray<readonly [string, string]> {
  return disposalPairs().map(([consumer, dependency]) => [dependency, consumer]);
}

/** How many factories the table lets a scheduler run at once: the async services are independent of each other. */
export function widthOf(concurrency: number): number {
  return Math.min(concurrency, SERVICES.filter((service) => service.async).length);
}

export function describeOp(op: CompositionOp): string {
  switch (op.kind) {
    case 'resolveUnbound':
      return `resolve ${op.token} on the unbound container`;
    case 'createScope':
      return `createScope(${op.binding}) from ${op.from}`;
    case 'initialize':
      return `initialize ${op.scope}${op.held ? ' held' : ''}`;
    case 'resolve':
      return `resolve ${op.token} on ${op.scope}`;
    case 'resolveMany':
      return `resolveMany [${op.tokens.join(', ')}] on ${op.scope}`;
    case 'destroy':
      return `destroy ${op.scope}`;
    case 'destroyParent':
      return 'destroy the parent';
  }
}

interface Scope {
  binding: 'one' | 'two' | undefined;
  initialized: boolean;
  destroyed: boolean;
  readonly built: Map<string, string>;
}

export function runCompositionModel(scenario: CompositionScenario): CompositionTrace {
  const constructs: Record<string, number> = {};
  const disposals: Record<string, number> = {};
  const count = (table: Record<string, number>, name: string): void => {
    table[name] = (table[name] ?? 0) + 1;
  };
  const parent = { destroyed: false, base: false };
  // Index 0 is the container that is given no inputs; the scopes made from it follow, in order.
  const scopes: Scope[] = [{ binding: undefined, initialized: false, destroyed: false, built: new Map() }];
  const events: CompositionEvent[] = [];
  let builtNow: string[] = [];

  const construct = (scope: Scope, name: string): string => {
    const cached = scope.built.get(name);
    if (cached !== undefined) return cached;
    const binding = scope.binding === undefined ? { id: '?', n: 0 } : BINDINGS[scope.binding];
    let tag = '';
    if (name === 'Base') {
      tag = 'Base';
      if (!parent.base) {
        parent.base = true;
        count(constructs, 'Base');
        builtNow.push('Base');
      }
      return tag;
    }
    if (name === 'A') tag = `A[${binding.id}]`;
    if (name === 'B') tag = `B[${binding.n},${construct(scope, 'A')}]`;
    if (name === 'E') tag = `E[${binding.n}]`;
    if (name === 'c') tag = 'c';
    if (name === 'd') tag = `d[${construct(scope, 'B')}]`;
    if (name === 'A') construct(scope, 'Base');
    scope.built.set(name, tag);
    count(constructs, name);
    builtNow.push(name);
    return tag;
  };

  const tagOf = (scope: Scope, token: Token): string => construct(scope, token === 'twin' ? 'B' : token);

  const refusal = (scope: Scope, token: Token): string => {
    if (scope.destroyed) return 'NEO_CONTAINER_DESTROYED';
    if (parent.destroyed) return 'NEO_SCOPE_PARENT_DESTROYED';
    if (!scope.initialized) return 'NEO_NOT_INITIALIZED';
    if (scenario.mode === 'closed' && !CLOSED_ROOTS.has(token)) return 'NEO_ROOT_NOT_EXPORTED';
    return '';
  };

  const dispose = (scope: Scope): string[] => {
    const names = [...scope.built.keys()];
    for (const name of names) count(disposals, name);
    scope.built.clear();
    return names.sort();
  };

  for (const op of scenario.ops) {
    builtNow = [];
    let disposed: string[] = [];
    let running = -1;
    let event: Pick<CompositionEvent, 'code' | 'value' | 'delivery'>;
    if (op.kind === 'resolveUnbound') {
      event = { code: 'NEO_SCOPE_INPUTS_UNBOUND', value: '', delivery: 'sync' };
    } else if (op.kind === 'createScope') {
      const from = scopes[op.from];
      if (from === undefined || from.destroyed) event = { code: 'NEO_CONTAINER_DESTROYED', value: '', delivery: 'sync' };
      else if (parent.destroyed) event = { code: 'NEO_SCOPE_PARENT_DESTROYED', value: '', delivery: 'sync' };
      else if (op.binding === 'missing') event = { code: 'NEO_SCOPE_INPUT_MISSING', value: '', delivery: 'sync' };
      else {
        scopes.push({ binding: op.binding, initialized: false, destroyed: false, built: new Map() });
        event = { code: '', value: 'scope', delivery: 'value' };
      }
    } else if (op.kind === 'initialize') {
      const scope = scopes[op.scope];
      if (scope === undefined || scope.destroyed) event = { code: 'NEO_CONTAINER_DESTROYED', value: '', delivery: 'reject' };
      else {
        if (op.during !== undefined && (op.held !== true || scope.initialized)) {
          throw new Error('a probe needs an initialization that is held and not over');
        }
        // Initializing (docs/guide/states-and-ownership.md, table "States"): `resolve` and `resolveMany` throw
        // `NEO_NOT_INITIALIZED`, `createScope` throws `NEO_CONTAINER_BUSY`; nothing is built and nothing is disposed.
        for (const probe of op.during ?? []) {
          const code = probe.kind === 'createScope' ? 'NEO_CONTAINER_BUSY' : 'NEO_NOT_INITIALIZED';
          events.push({ op: describeProbe(op.scope, probe), code, value: '', delivery: 'sync', built: [], disposed: [], running: -1 });
        }
        if (!scope.initialized) {
          for (const service of SERVICES) if (service.async) construct(scope, service.name);
          scope.initialized = true;
        }
        event = { code: '', value: '', delivery: 'value' };
        if (op.held) running = widthOf(scenario.concurrency);
      }
    } else if (op.kind === 'resolve') {
      const scope = scopes[op.scope];
      const code = scope === undefined ? 'NEO_CONTAINER_DESTROYED' : refusal(scope, op.token);
      if (scope === undefined || code !== '') event = { code, value: '', delivery: 'sync' };
      else event = { code: '', value: tagOf(scope, op.token), delivery: 'value' };
    } else if (op.kind === 'resolveMany') {
      const scope = scopes[op.scope];
      const first = scope === undefined ? 'NEO_CONTAINER_DESTROYED' : refusal(scope, op.tokens[0] ?? 'c');
      // A destroyed, parent-less or not initialized container refuses the batch whole, empty or not.
      if (scope === undefined || (first !== '' && first !== 'NEO_ROOT_NOT_EXPORTED')) {
        event = { code: first, value: '', delivery: 'sync' };
      } else {
        // The batch stops on the first refusal: the services before it stay built, the ones after it are never asked.
        const answers: string[] = [];
        let stopped = '';
        for (const token of op.tokens) {
          stopped = refusal(scope, token);
          if (stopped !== '') break;
          answers.push(tagOf(scope, token));
        }
        event = stopped === '' ? { code: '', value: `[${answers.join('|')}]`, delivery: 'value' } : { code: stopped, value: '', delivery: 'sync' };
      }
    } else if (op.kind === 'destroy') {
      const scope = scopes[op.scope];
      if (scope !== undefined && !scope.destroyed) {
        disposed = dispose(scope);
        scope.destroyed = true;
      }
      event = { code: '', value: '', delivery: 'value' };
    } else {
      if (!parent.destroyed) {
        if (parent.base) {
          count(disposals, 'Base');
          disposed = ['Base'];
        }
        parent.destroyed = true;
      }
      event = { code: '', value: '', delivery: 'value' };
    }
    events.push({ op: describeOp(op), ...event, built: [...builtNow].sort(), disposed, running });
  }
  return { events, constructs, disposals };
}
