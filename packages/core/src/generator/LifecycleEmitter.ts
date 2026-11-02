import type { DependencyGraph, ServiceDefinition, TokenId } from '../analyzer/types';
import { getFactoryName, multiRegistrationKey, resolveTokenKey, type GetImport } from './FactoryEmitter';
import { afterStore, generateOverrideMultiGuard, isBorrowedInstance } from './ResolveEmitter';

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
      add(id, `{ const __neoValue = await this.${factoryId}(); ${afterStore('__neoValue', key, true, isBorrowedInstance(node.service))} }`);
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
    add(`node:${tokenId}`, `if (!this.overrides.has(${tokenKey})) { const __neoValue = await this.${factoryId}(); ${afterStore('__neoValue', tokenKey, true, isBorrowedInstance(node.service))} }`);
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
  eagerLines: string[] = [],
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
  lines.push(...eagerLines);

  const initializeOutput = `public async initialize(): Promise<void> {
    if (this._state === 'initializing') return this._initWork;
    if (this._state === 'ready') return Promise.resolve();
    if (this._state === 'failed') return Promise.reject(this._failure);
    if (this._state === 'destroying' || this._state === 'destroyed') {
      throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
    }
    if (this._state === 'reconfiguring') throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
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
      if (this._state === 'destroying') throw __neoInitError;
      const __neoCleanup = [];
      const __neoSeen = new Set();
      for (const __neoKey of [...this._initJournal].reverse()) {
        const __neoInst = this.instances.get(__neoKey);
        this.instances.delete(__neoKey);
        if (__neoInst == null || this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)) continue;
        __neoSeen.add(__neoInst);
        try {
          if (typeof __neoInst.dispose === 'function') {
            const __neoResult = __neoInst.dispose();
            if (__neoResult && typeof __neoResult.then === 'function') await __neoResult;
          }
        } catch (__neoDisposeError) {
          __neoCleanup.push(__neoDisposeError);
        }
      }
      if (__neoCleanup.length === 0) {
        if (this._state !== 'destroying') this._state = 'failed';
        throw __neoInitError;
      }
      const __neoWrapped = new Error(__neoInitError instanceof Error ? __neoInitError.message : String(__neoInitError)) as Error & { cause?: unknown; cleanupErrors?: unknown[] };
      __neoWrapped.cause = __neoInitError;
      __neoWrapped.cleanupErrors = __neoCleanup;
      this._failure = __neoWrapped;
      if (this._state !== 'destroying') this._state = 'failed';
      throw __neoWrapped;
    } finally {
      this._initRunning = false;
    }
  }

  private _guardPublic(op: string = 'resolve()'): void {
    if (this._state === 'created' || this._state === 'initializing') {
      throw this._neoFail('NEO_NOT_INITIALIZED', 'call await container.initialize() before ' + op);
    }
    if (this._state === 'reconfiguring') {
      throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
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
  return `public initialize(): Promise<void> {
    if (this._touchClosed(false)) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    if (this._reconfiguring) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    if (this._failure !== undefined) return Promise.reject(this._failure);
    return Promise.resolve();
  }`;
}

/** Sync eager roots run once. A second initialize() is a no-op. ADR006 line 12. */
export function generateEagerSyncInitialize(lines: string[]): string {
  return `public initialize(): Promise<void> {
    if (this._eagerOnce) return Promise.resolve();
    if (this._touchClosed(false)) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));
    if (this._reconfiguring) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));
    if (this._failure !== undefined) return Promise.reject(this._failure);
    this._eagerOnce = true;
    ${lines.join('\n    ')}
    return Promise.resolve();
  }`;
}

/** A scope shares the parent list and the name. It does not copy caches or call initialize(). */
export function generateCreateScopeMethod(className: string, hasAsync: boolean): string {
  const guard = hasAsync
    ? `if (this._state === 'destroying' || this._state === 'destroyed' || this._touchClosed(false)) {
    throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
  }
  if (this._state === 'failed') {
    throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed');
  }
  if (this._state === 'initializing' || this._state === 'reconfiguring') {
    throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
  }`
    : `if (this._reconfiguring) {
    throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');
  }
  if (this._failure !== undefined) {
    throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure);
  }
  if (this._touchClosed(false)) {
    throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');
  }`;
  return `public createScope(): this {
    ${guard}
    return new ${className}(this.legacy, this.name);
  }`;
}

/** Destroy and resolve share this helper so one edit changes both sides. */
export function touchClosedMethod(): string {
  return `private _touchClosed(mark: boolean): boolean {
    if (mark) this._closed = true;
    return this._closed;
  }`;
}

export function assertParentsMethod(): string {
  return `private _assertParents(): void {
    if (!this.legacy) return;
    for (const legacyContainer of this.legacy) {
      if (legacyContainer && legacyContainer._closed) {
        throw this._neoFail('NEO_SCOPE_PARENT_DESTROYED', 'parent is destroyed: ' + legacyContainer.name);
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

function slotKind(service: ServiceDefinition): 'skip' | 'unguarded' | 'guarded' {
  if (service.lifecycle === 'transient' || service.type === 'parent') return 'skip';
  if (isBorrowedInstance(service)) return 'skip';
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
  const awaitClose = ordered.some((slot) => slot.guarded || slot.isAsync || slot.late);
  return { slots: ordered, awaitClose };
}

function disposeCall(slot: DisposalSlot, immediateAwait: boolean): string {
  if (slot.guarded) {
    const follow = immediateAwait
      ? `if (__neoResult && typeof __neoResult.then === 'function') await __neoResult;`
      : `if (__neoResult && typeof __neoResult.then === 'function') __neoPending.push(__neoResult);`;
    return `if (typeof __neoInst?.dispose === 'function') { const __neoResult = __neoInst.dispose(); ${follow} }`;
  }
  if (immediateAwait) {
    return `const __neoResult = (__neoInst as any).dispose(); if (__neoResult && typeof __neoResult.then === 'function') await __neoResult;`;
  }
  return `(__neoInst as any).dispose();`;
}

function disposeSlot(slot: DisposalSlot, immediateAwait: boolean): string {
  const call = disposeCall(slot, immediateAwait);
  return `if (this.instances.has(${slot.tokenKey})) { const __neoInst = this.instances.get(${slot.tokenKey}); if (!(__neoInst != null && (this._borrowed.has(__neoInst) || __neoSeen.has(__neoInst)))) { if (__neoInst != null) __neoSeen.add(__neoInst); try { ${call} } catch (__neoDisposeError) { __neoErrors.push(__neoDisposeError); } } }`;
}

function sharedDisposalLines(slots: DisposalSlot[], awaitClose: boolean): string[] {
  const lines = ['const __neoSeen = new Set();', 'const __neoErrors = [];'];
  const early = slots.filter((slot) => !slot.late);
  const late = slots.filter((slot) => slot.late);
  const defer = awaitClose && early.some((slot) => slot.guarded);
  if (defer) lines.push('const __neoPending = [];');
  for (const slot of early) lines.push(disposeSlot(slot, false));
  if (defer) {
    lines.push('for (const __neoPendingItem of __neoPending) { try { await __neoPendingItem; } catch (__neoDisposeError) { __neoErrors.push(__neoDisposeError); } }');
  }
  for (const slot of late) lines.push(disposeSlot(slot, true));
  lines.push('this.instances.clear();');
  return lines;
}

function disposalLines(slots: DisposalSlot[], awaitClose: boolean): string[] {
  return [
    ...sharedDisposalLines(slots, awaitClose),
    'this.overrides.clear();',
    'this.resolveListeners.clear();',
    'if (__neoErrors.length > 0) { const __neoDisposeFailure = new AggregateError(__neoErrors); throw __neoDisposeFailure; }',
  ];
}

/**
 * override() and clearOverrides(). The gate is synchronous.
 * Cleanup finishes before the new override table is applied.
 * A borrowed mock is removed from `_borrowed` and never disposed.
 */
export function generateOverrideMethods(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync: boolean,
  testOverrides: boolean,
): string {
  const collected = combinedDisposals(graph, sorted, getImport);
  const disposalBody = sharedDisposalLines(collected.slots, collected.awaitClose).join('\n    ');
  const enabled = testOverrides ? 'true' : 'false';
  const testApiGate = `if (!${enabled}) return Promise.reject(this._neoFail('NEO_TEST_API_DISABLED', 'test overrides are disabled'));`;
  const busyCheck = hasAsync
    ? `if (this._state === 'initializing' || this._state === 'reconfiguring' || this._state === 'destroying') return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));`
    : `if (this._reconfiguring || this._destroyWork) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));`;
  const destroyedCheck = hasAsync
    ? `if (this._state === 'destroyed' || this._touchClosed(false)) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));`
    : `if (this._touchClosed(false) === true) return Promise.reject(this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed'));`;
  const failedCheck = hasAsync
    ? `if (this._state === 'failed' || this._failure !== undefined) return Promise.reject(this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure));`
    : `if (this._failure !== undefined) return Promise.reject(this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure));`;
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
  const multiGuard = generateOverrideMultiGuard(graph, getImport);

  return `public override(token: any, factory: () => any): Promise<void> {
    ${testApiGate}
    ${busyCheck}
    ${destroyedCheck}
    ${failedCheck}
    ${multiGuard}
    ${arm}
    return this._reconfigure(() => { this.overrides.set(token, factory); });
  }

  public clearOverrides(): Promise<void> {
    ${testApiGate}
    ${busyCheck}
    ${destroyedCheck}
    ${failedCheck}
    ${arm}
    return this._reconfigure(() => { this.overrides.clear(); });
  }

  private async _reconfigure(apply: () => void): Promise<void> {
    const __neoMocks = [];
    for (const __neoToken of this.overrides.keys()) {
      if (this.instances.has(__neoToken)) __neoMocks.push(this.instances.get(__neoToken));
    }
    try {
      ${disposalBody}
      for (const __neoMock of __neoMocks) this._borrowed.delete(__neoMock);
      if (__neoErrors.length > 0) {
        const __neoDisposeFailure = new AggregateError(__neoErrors);
        ${onFailure}
        throw __neoDisposeFailure;
      }
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
 * Generates the destroy() method.
 * Disposes cached singletons consumer-before-dependency.
 * A sync class stays a non-async method. Async work waits inside _close or _runDestroy.
 */
export function generateDestroyMethod(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
): string {
  const collected = combinedDisposals(graph, sorted, getImport);
  const lines = disposalLines(collected.slots, collected.awaitClose);
  const body = lines.join('\n    ');
  const join = destroyJoinPrefix();
  const reconfigBusy = `if (${hasAsync ? "this._state === 'reconfiguring'" : "this._reconfiguring"}) return Promise.reject(this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning'));`;

  if (!hasAsync) {
    if (collected.awaitClose) {
      return `public async destroy(): Promise<void> {
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    const __neoRun = this._runDestroy();
    this._destroyWork = __neoRun;
    try {
      await __neoRun;
    } finally {
      this._destroyWork = undefined;
    }
  }

  private async _runDestroy(): Promise<void> {
    ${body}
  }`;
    }

    return `public destroy(): Promise<void> {
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    try {
      ${body}
    } catch (__neoDestroyError) {
      return Promise.reject(__neoDestroyError);
    }
    return Promise.resolve();
  }`;
  }

  const finish = collected.awaitClose ? 'await this._close();' : 'this._close();';
  const closeHead = collected.awaitClose
    ? 'private async _close(): Promise<void> {'
    : 'private _close(): void {';

  return `public destroy(): Promise<void> {
    ${join}
    ${reconfigBusy}
    this._touchClosed(true);
    if (this._state === 'destroyed') return Promise.resolve();
    if (this._state === 'created') {
      this._state = 'destroyed';
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
        if (this._state === 'destroying') this._state = 'destroyed';
      }
    })();
    this._destroyWork = __neoRun;
    const __neoClear = () => { if (this._destroyWork === __neoRun) this._destroyWork = undefined; };
    void __neoRun.then(__neoClear, __neoClear);
    return __neoRun;
  }

  ${closeHead}
    ${body}
  }`;
}
