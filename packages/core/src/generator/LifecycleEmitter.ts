import type { DependencyGraph, TokenId } from '../analyzer/types';
import { getFactoryName, multiRegistrationKey, resolveTokenKey, type GetImport } from './FactoryEmitter';

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

function stableOrder<T extends { id: string }>(steps: T[], before: Map<string, Set<string>>): T[] {
  const remaining = new Set(steps.map((step) => step.id));
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered: T[] = [];
  while (remaining.size > 0) {
    let picked: string | undefined;
    for (const step of steps) {
      if (!remaining.has(step.id)) continue;
      const preds = before.get(step.id);
      if (!preds || [...preds].every((pred) => !remaining.has(pred))) {
        picked = step.id;
        break;
      }
    }
    if (!picked) {
      for (const step of steps) {
        if (remaining.has(step.id)) ordered.push(step);
      }
      break;
    }
    remaining.delete(picked);
    const step = byId.get(picked);
    if (step) ordered.push(step);
  }
  return ordered;
}

function collectMultiAsyncLines(
  graph: DependencyGraph,
  getImport: GetImport,
  add: (id: string, line: string) => void,
  multiIds: Map<string, string[]>,
): void {
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    const ids: string[] = [];
    nodes.forEach((node, index) => {
      if (!node.service.isAsync || node.service.lifecycle !== 'singleton') return;
      const id = `multi:${tokenId}:${index}`;
      const key = multiRegistrationKey(node, tokenId, index);
      const factoryId = `${getFactoryName(tokenId)}_${index}`;
      add(id, `{ const __neoValue = await this.${factoryId}(); this.instances.set(${key}, __neoValue); if (this._initRunning) this._initJournal.push(${key}); }`);
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
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    for (const dep of node.dependencies) needs(`node:${tokenId}`, `node:${dep}`);
  }
}

function orderedAsyncLines(graph: DependencyGraph, sorted: TokenId[], getImport: GetImport): string[] {
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
    add(`node:${tokenId}`, `{ const __neoValue = await this.${factoryId}(); this.instances.set(${tokenKey}, __neoValue); if (this._initRunning) this._initJournal.push(${tokenKey}); }`);
  }

  collectMultiAsyncLines(graph, getImport, add, multiIds);

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
        for (const dep of node.dependencies) {
          needs(id, `node:${dep}`);
          for (const pred of multiIds.get(dep) ?? []) needs(id, pred);
        }
      });
    }
  }
  linkNodeOrder(sorted, graph, needs);
  linkAsyncConsumers(graph, multiIds, needs);
  return stableOrder(steps, before).map((step) => step.line);
}

/**
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
): string {
  if (!hasAsync) return generateSyncInitializeMethod();

  const lines: string[] = [];

  // Cascade first: a local async factory may itself resolve() a parent-provided
  // singleton, so the parent/legacy chain must be ready before we create ours.
  // Guarded at runtime (not statically) so this also covers declareContainerTokens
  // legacy adapters we can't analyze — if one happens to expose its own
  // initialize(), it still gets awaited; if not, this is a harmless no-op.
  lines.push(
    `if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }`
  );
  lines.push(...orderedAsyncLines(graph, sorted, getImport));

  const initializeOutput = `public async initialize(): Promise<void> {
    if (this._state === 'initializing') return this._initWork;
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
    }
    this._state = 'initializing';
    this._initWork = this._runInitialize();
    return this._initWork;
  }

  private async _runInitialize(): Promise<void> {
    this._initRunning = true;
    try {
      ${lines.join('\n      ')}
      if (this._state === 'initializing') this._state = 'ready';
    } catch (__neoInitError) {
      this._failure = __neoInitError;
      if (this._state !== 'destroying') this._state = 'failed';
      throw __neoInitError;
    } finally {
      this._initRunning = false;
    }
  }

  private _guardPublic(op: string = 'resolve()'): void {
    if (this._state === 'created' || this._state === 'initializing') {
      throw this._neoFail('NEO_NOT_INITIALIZED', 'call await container.initialize() before ' + op);
    }
    if (this._state === 'failed') {
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
  return initializeOutput;
}

/**
 * Sync containers still expose initialize(). It is not `async` and it does not
 * touch `_initialized`: those shapes belong to containers that have async work.
 */
export function generateSyncInitializeMethod(): string {
  return 'public initialize(): Promise<void> { return Promise.resolve(); }';
}

/** createScope is on the public type. This build has no scope behaviour yet. */
export function generateCreateScopeMethod(): string {
  return `public createScope(): this {
    throw new Error('createScope() is not implemented yet in this build');
  }`;
}

interface DisposalSlot {
  id: string;
  tokenKey: string;
  isAsync: boolean;
  guarded: boolean;
}

function linkContributionDependencies(
  graph: DependencyGraph,
  edge: (first: string, later: string) => void,
): void {
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const id = `multi:${tokenId}:${index}`;
      for (const dep of node.dependencies) edge(id, `node:${dep}`);
    });
  }
}

function linkNodeDisposal(
  graph: DependencyGraph,
  sorted: TokenId[],
  edge: (first: string, later: string) => void,
): void {
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    for (const dep of node.dependencies) edge(`node:${tokenId}`, `node:${dep}`);
  }
}

function combinedDisposals(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
): DisposalSlot[] {
  const slots: DisposalSlot[] = [];
  const seen = new Set<string>();
  const add = (slot: DisposalSlot) => {
    if (seen.has(slot.id)) return;
    seen.add(slot.id);
    slots.push(slot);
  };

  for (const tokenId of [...sorted].reverse()) {
    const node = graph.nodes.get(tokenId);
    if (!node || node.service.lifecycle === 'transient') continue;
    if (!node.service.isDisposable && !node.service.isAsyncDisposable) continue;
    add({
      id: `node:${tokenId}`,
      tokenKey: resolveTokenKey(node.service, getImport),
      isAsync: !!node.service.isAsyncDisposable,
      guarded: false,
    });
  }

  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      nodes.forEach((node, index) => {
        if (node.service.lifecycle === 'transient') return;
        const flagged = !!node.service.isDisposable || !!node.service.isAsyncDisposable;
        if (!flagged && node.service.type !== 'factory') return;
        add({
          id: `multi:${tokenId}:${index}`,
          tokenKey: multiRegistrationKey(node, tokenId, index),
          isAsync: !!node.service.isAsyncDisposable,
          guarded: !flagged,
        });
      });
    }
  }

  const before = new Map<string, Set<string>>();
  const edge = (first: string, later: string) => {
    if (!seen.has(first) || !seen.has(later) || first === later) return;
    const set = before.get(later) ?? new Set<string>();
    set.add(first);
    before.set(later, set);
  };
  linkContributionDependencies(graph, edge);
  linkNodeDisposal(graph, sorted, edge);
  return stableOrder(slots, before);
}

function plainDisposalLines(slots: Array<{ tokenKey: string; isAsync: boolean; guarded?: boolean }>): string[] {
  const lines: string[] = [];
  for (const slot of slots) {
    if (slot.guarded) {
      const call = slot.isAsync ? 'await __neoInst.dispose()' : '__neoInst.dispose()';
      lines.push(`if (this.instances.has(${slot.tokenKey})) { const __neoInst = this.instances.get(${slot.tokenKey}); if (typeof __neoInst?.dispose === 'function') { ${call} } }`);
      continue;
    }
    const call = slot.isAsync
      ? `await (this.instances.get(${slot.tokenKey}) as any).dispose();`
      : `(this.instances.get(${slot.tokenKey}) as any).dispose();`;
    lines.push(`if (this.instances.has(${slot.tokenKey})) { ${call} }`);
  }
  lines.push('this.instances.clear();');
  lines.push('this.overrides.clear();');
  lines.push('this.resolveListeners.clear();');
  return lines;
}

function multiDisposalLines(slots: Array<{ tokenKey: string; isAsync: boolean; guarded?: boolean }>): string[] {
  const lines: string[] = [];
  lines.push('const __neoSeen = new Set();');
  lines.push('const __neoErrors = [];');
  for (const slot of slots) {
    // A parent-resolved object returned by a multi factory is ownership borrowed (T09); this slot does not skip it.
    const body = slot.guarded
      ? "if (typeof __neoInst?.dispose === 'function') { await __neoInst.dispose(); }"
      : slot.isAsync
        ? 'await (__neoInst as any).dispose();'
        : '(__neoInst as any).dispose();';
    lines.push(`if (this.instances.has(${slot.tokenKey})) { const __neoInst = this.instances.get(${slot.tokenKey}); if (!(__neoInst != null && __neoSeen.has(__neoInst))) { if (__neoInst != null) __neoSeen.add(__neoInst); try { ${body} } catch (__neoDisposeError) { __neoErrors.push(__neoDisposeError); } } }`);
  }
  lines.push('this.instances.clear();');
  lines.push('this.overrides.clear();');
  lines.push('this.resolveListeners.clear();');
  lines.push('if (__neoErrors.length > 0) { const __neoDisposeFailure = new AggregateError(__neoErrors); throw __neoDisposeFailure; }');
  return lines;
}

/**
 * Generates the destroy() method.
 * Calls dispose() on cached singleton services in reverse dependency order.
 * Becomes async if a singleton dispose is async or a guarded factory dispose is emitted.
 */
export function generateDestroyMethod(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
): string {
  const hasAsyncDisposable = hasAsyncDisposables(graph, sorted);

  // Collect disposable singletons in reverse dependency order.
  // With no multi registrations the loop below stays the historical output.
  const disposables: Array<{ tokenKey: string; isAsync: boolean; guarded?: boolean }> = [];
  if (!graph.multiNodes || graph.multiNodes.size === 0) {
    for (const tokenId of [...sorted].reverse()) {
      const node = graph.nodes.get(tokenId);
      if (!node) continue;
      if (node.service.lifecycle === 'transient') continue;
      if (!node.service.isDisposable && !node.service.isAsyncDisposable) continue;

      disposables.push({
        tokenKey: resolveTokenKey(node.service, getImport),
        isAsync: !!node.service.isAsyncDisposable,
      });
    }
  } else {
    disposables.push(...combinedDisposals(graph, sorted, getImport));
  }

  const multi = !!graph.multiNodes && graph.multiNodes.size > 0;
  const lines = multi ? multiDisposalLines(disposables) : plainDisposalLines(disposables);
  const awaitClose = hasAsyncDisposable || disposables.some((slot) => slot.guarded === true);

  if (!hasAsync) {
    if (awaitClose) {
      return `public async destroy(): Promise<void> {
    ${lines.join('\n    ')}
  }`;
    }

    return `public destroy(): Promise<void> {
    ${lines.join('\n    ')}
    return Promise.resolve();
  }`;
  }

  const close = awaitClose
    ? `private async _close(): Promise<void> {
    ${lines.join('\n    ')}
  }`
    : `private _close(): void {
    ${lines.join('\n    ')}
  }`;
  const finish = awaitClose ? 'await this._close();' : 'this._close();';
  const head = awaitClose
    ? 'public async destroy(): Promise<void> {'
    : 'public destroy(): Promise<void> {';

  return `${head}
    if (this._state === 'destroyed' || this._state === 'destroying') {
      return this._destroyWork ?? Promise.resolve();
    }
    if (this._state === 'created') {
      this._state = 'destroyed';
      return Promise.resolve();
    }
    const __neoDestroy = (async () => {
      this._state = 'destroying';
      if (this._initWork) {
        try { await this._initWork; } catch { /* initialization failure stays on _failure */ }
      }
      ${finish}
      this._state = 'destroyed';
    })();
    this._destroyWork = __neoDestroy;
    return __neoDestroy;
  }

  ${close}`;
}
