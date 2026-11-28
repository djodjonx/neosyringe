/**
 * Independent lifecycle interpreter for the topic 06 corpus.
 * It does not import the generator and it does not copy its branches.
 * `undefined` is a stored value. A cycle is rejected by an explicit stack.
 */

export type ModelPrimitive = number | boolean | undefined;

export interface ModelService {
  readonly name: string;
  readonly kind: 'singleton' | 'transient';
  readonly value: ModelPrimitive;
  readonly borrowed: boolean;
  readonly disposable: boolean;
  readonly deps: readonly string[];
}

export type ModelOp =
  | { readonly kind: 'initialize' | 'destroy' | 'createScope'; readonly scope: number }
  | { readonly kind: 'resolve'; readonly name: string; readonly scope: number };

export interface Scenario {
  readonly services: readonly ModelService[];
  readonly ops: readonly ModelOp[];
  readonly profile: 'full' | 'minimal';
  readonly mode: 'open' | 'closed';
}

export interface TraceEvent {
  readonly value: string;
  readonly code: string;
  readonly delivery: 'value' | 'sync' | 'reject';
}

export interface Trace {
  readonly events: readonly TraceEvent[];
  readonly constructs: Readonly<Record<string, number>>;
  readonly disposals: Readonly<Record<string, number>>;
}

export const CORPUS_SEEDS = [1, 2, 3, 7, 11] as const;

const NAMES = ['Na', 'Nb', 'Nc'] as const;

export function showValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null) {
    const tag = Reflect.get(value, 'tag');
    if (typeof tag === 'string') return `obj:${tag}`;
  }
  return 'other';
}

/** Iterative. A long ring must not grow the call stack. */
export function cycleCode(services: readonly ModelService[]): string {
  const deps = new Map(services.map((service) => [service.name, service.deps]));
  const color = new Map<string, number>();
  for (const service of services) {
    if ((color.get(service.name) ?? 0) !== 0) continue;
    const stack: Array<{ name: string; index: number }> = [{ name: service.name, index: 0 }];
    color.set(service.name, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const edges = deps.get(frame.name) ?? [];
      if (frame.index >= edges.length) {
        color.set(frame.name, 2);
        stack.pop();
        continue;
      }
      const next = edges[frame.index];
      frame.index += 1;
      if (next === undefined) continue;
      const seen = color.get(next) ?? 0;
      if (seen === 1) return 'NEO_CYCLE';
      if (seen === 0 && deps.has(next)) {
        color.set(next, 1);
        stack.push({ name: next, index: 0 });
      }
    }
  }
  return '';
}

export function pinnedUndefined(): Scenario {
  const services: readonly ModelService[] = [
    { name: 'Na', kind: 'singleton', value: undefined, borrowed: false, disposable: false, deps: [] },
    { name: 'Nb', kind: 'singleton', value: 1, borrowed: false, disposable: true, deps: [] },
  ];
  return { services, ops: standardOps(services), profile: 'full', mode: 'open' };
}

export function scenarioFor(seed: number): Scenario {
  const rand = mulberry32(seed);
  const services: ModelService[] = [];
  for (let index = 0; index < NAMES.length; index += 1) {
    const name = NAMES[index] ?? 'Na';
    const kind = rand() < 0.3 ? 'transient' : 'singleton';
    const borrowedRoll = rand();
    const borrowed = kind === 'singleton' && borrowedRoll < 0.3;
    const disposable = rand() < 0.5;
    const roll = rand();
    let value: ModelPrimitive = roll < 0.25 ? 0 : roll < 0.5 ? false : roll < 0.75 ? undefined : index + 1;
    // A transient undefined is the reference-emitter fall-through. The corpus keeps a stored value.
    if (kind === 'transient' && value === undefined) value = index + 1;
    const previous = services[index - 1];
    const captured = previous !== undefined
      && previous.kind === 'transient'
      && previous.disposable
      && kind === 'singleton';
    const deps = index > 0 && !captured && rand() < 0.6 ? [previous?.name ?? 'Na'] : [];
    services.push({ name, kind, value, borrowed, disposable, deps });
  }
  const profile = rand() < 0.5 ? 'minimal' : 'full';
  const mode = rand() < 0.5 ? 'closed' : 'open';
  return { services, ops: seededOps(services, rand), profile, mode };
}

export function runModel(scenario: Scenario): Trace {
  const byName = new Map(scenario.services.map((service) => [service.name, service]));
  const constructs = zeroCounts(scenario.services);
  const disposals = zeroCounts(scenario.services);
  const scopes: Scope[] = [{ state: 'ready', cache: new Map() }];
  const events: TraceEvent[] = [];

  const construct = (scope: Scope, name: string): unknown => {
    const node = byName.get(name);
    if (!node) return undefined;
    if (node.kind === 'singleton') {
      const hit = scope.cache.get(name);
      if (hit) return hit.value;
    }
    for (const dep of node.deps) construct(scope, dep);
    constructs[name] = (constructs[name] ?? 0) + 1;
    const value = node.disposable ? { tag: name } : node.value;
    if (node.kind === 'singleton') scope.cache.set(name, { value, node });
    return value;
  };

  const disposeScope = (scope: Scope): void => {
    const built = [...scope.cache.values()];
    for (let index = built.length - 1; index >= 0; index -= 1) {
      const entry = built[index];
      if (!entry || entry.node.kind !== 'singleton' || entry.node.borrowed || !entry.node.disposable) continue;
      const name = entry.node.name;
      disposals[name] = (disposals[name] ?? 0) + 1;
    }
  };

  for (const op of scenario.ops) {
    const scope = scopes[op.scope];
    if (!scope) {
      events.push({ value: '', code: 'NEO_CONTAINER_DESTROYED', delivery: 'sync' });
      continue;
    }
    if (op.kind === 'initialize') {
      events.push(scope.state === 'destroyed'
        ? { value: '', code: 'NEO_CONTAINER_DESTROYED', delivery: 'reject' }
        : { value: '', code: '', delivery: 'value' });
      continue;
    }
    if (op.kind === 'createScope') {
      if (scope.state === 'destroyed') {
        events.push({ value: '', code: 'NEO_CONTAINER_DESTROYED', delivery: 'sync' });
        continue;
      }
      scopes.push({ state: 'ready', cache: new Map() });
      events.push({ value: 'scope', code: '', delivery: 'value' });
      continue;
    }
    if (op.kind === 'destroy') {
      if (scope.state !== 'destroyed') {
        disposeScope(scope);
        scope.state = 'destroyed';
        scope.cache.clear();
      }
      events.push({ value: '', code: '', delivery: 'value' });
      continue;
    }
    if (op.kind !== 'resolve') continue;
    if (scope.state === 'destroyed') {
      events.push({ value: '', code: 'NEO_CONTAINER_DESTROYED', delivery: 'sync' });
      continue;
    }
    events.push({ value: showValue(construct(scope, op.name)), code: '', delivery: 'value' });
  }

  return { events, constructs, disposals };
}

/** A ring large enough that a recursive walk would be the wrong tool. */
export function longRing(size: number): ModelService[] {
  const services: ModelService[] = [];
  for (let index = 0; index < size; index += 1) {
    const name = `R${index}`;
    const next = `R${(index + 1) % size}`;
    services.push({ name, kind: 'singleton', value: index, borrowed: false, disposable: false, deps: [next] });
  }
  return services;
}

interface Cached {
  readonly value: unknown;
  readonly node: ModelService;
}

interface Scope {
  state: 'ready' | 'destroyed';
  readonly cache: Map<string, Cached>;
}

function seededOps(services: readonly ModelService[], rand: () => number): ModelOp[] {
  const names = services.map((service) => service.name);
  const pickName = (): string => names[Math.floor(rand() * names.length)] ?? 'Na';
  const ops: ModelOp[] = [];
  let count = 1;
  const dead = new Set<number>();
  const kinds = ['resolve', 'initialize', 'destroy', 'createScope'] as const;

  const liveScope = (): number => {
    let left = count;
    while (left > 0) {
      const pick = Math.floor(rand() * count);
      if (!dead.has(pick)) return pick;
      left -= 1;
    }
    return 0;
  };

  const pushKind = (kind: (typeof kinds)[number], scope: number): void => {
    if (kind === 'resolve') {
      ops.push({ kind: 'resolve', name: pickName(), scope });
      return;
    }
    if (kind === 'createScope') {
      ops.push({ kind: 'createScope', scope });
      if (!dead.has(scope)) count += 1;
      return;
    }
    if (kind === 'destroy') {
      ops.push({ kind: 'destroy', scope });
      dead.add(scope);
      return;
    }
    ops.push({ kind: 'initialize', scope });
  };

  ops.push({ kind: 'initialize', scope: 0 });
  ops.push({ kind: 'createScope', scope: 0 });
  count = 2;

  const steps = 4 + Math.floor(rand() * 5);
  for (let index = 0; index < steps; index += 1) {
    const kind = kinds[Math.floor(rand() * kinds.length)] ?? 'resolve';
    const scope = rand() < 0.4 && dead.size > 0
      ? ([...dead][Math.floor(rand() * dead.size)] ?? 0)
      : liveScope();
    pushKind(kind, scope);
  }

  const parent = liveScope();
  ops.push({ kind: 'createScope', scope: parent });
  if (!dead.has(parent)) count += 1;
  const child = count - 1;
  ops.push({ kind: 'resolve', name: pickName(), scope: child });
  ops.push({ kind: 'destroy', scope: child });
  dead.add(child);
  ops.push({ kind: 'resolve', name: pickName(), scope: child });
  ops.push({ kind: 'createScope', scope: child });
  if (!dead.has(0)) {
    ops.push({ kind: 'destroy', scope: 0 });
    dead.add(0);
  }
  ops.push({ kind: 'initialize', scope: 0 });
  ops.push({ kind: 'resolve', name: pickName(), scope: 0 });
  ops.push({ kind: 'createScope', scope: 0 });
  return ops;
}

function standardOps(services: readonly ModelService[]): ModelOp[] {
  const first = services[0]?.name ?? 'Na';
  const ops: ModelOp[] = [{ kind: 'initialize', scope: 0 }];
  for (const service of services) ops.push({ kind: 'resolve', name: service.name, scope: 0 });
  ops.push({ kind: 'resolve', name: first, scope: 0 });
  ops.push({ kind: 'createScope', scope: 0 });
  ops.push({ kind: 'resolve', name: first, scope: 1 });
  ops.push({ kind: 'destroy', scope: 1 });
  ops.push({ kind: 'resolve', name: first, scope: 0 });
  ops.push({ kind: 'destroy', scope: 0 });
  ops.push({ kind: 'destroy', scope: 0 });
  ops.push({ kind: 'resolve', name: first, scope: 0 });
  ops.push({ kind: 'createScope', scope: 0 });
  return ops;
}

function zeroCounts(services: readonly ModelService[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const service of services) counts[service.name] = 0;
  return counts;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}
