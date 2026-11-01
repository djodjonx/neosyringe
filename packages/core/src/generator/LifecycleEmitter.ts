import type { DependencyGraph, TokenId } from '../analyzer/types';
import { getFactoryName, resolveTokenKey, type GetImport } from './FactoryEmitter';

/** Returns true if any node in the graph has an async factory. */
export function hasAsyncFactories(graph: DependencyGraph): boolean {
  for (const node of graph.nodes.values()) {
    if (node.service.isAsync) return true;
  }
  return false;
}

/** Returns true if any singleton in the graph has an async disposable implementation. */
export function hasAsyncDisposables(graph: DependencyGraph, sorted: TokenId[]): boolean {
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (node?.service.isAsyncDisposable && node.service.lifecycle === 'singleton') return true;
  }
  return false;
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

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node?.service.isAsync || node.service.lifecycle !== 'singleton') continue;
    const factoryId = getFactoryName(tokenId);
    const tokenKey = resolveTokenKey(node.service, getImport);
    lines.push(`{ const __neoValue = await this.${factoryId}(); this.instances.set(${tokenKey}, __neoValue); if (this._initRunning) this._initJournal.push(${tokenKey}); }`);
  }

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

/**
 * Generates the destroy() method.
 * Calls dispose() on cached singleton services in reverse dependency order.
 * Becomes async if any service has isAsyncDisposable.
 */
export function generateDestroyMethod(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
): string {
  const hasAsyncDisposable = hasAsyncDisposables(graph, sorted);

  // Collect disposable singletons in reverse dependency order
  const disposables: Array<{ tokenKey: string; isAsync: boolean }> = [];
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

  const lines: string[] = [];
  for (const { tokenKey, isAsync } of disposables) {
    const call = isAsync
      ? `await (this.instances.get(${tokenKey}) as any).dispose();`
      : `(this.instances.get(${tokenKey}) as any).dispose();`;
    lines.push(`if (this.instances.has(${tokenKey})) { ${call} }`);
  }
  lines.push('this.instances.clear();');
  lines.push('this.overrides.clear();');
  lines.push('this.resolveListeners.clear();');

  if (!hasAsync) {
    if (hasAsyncDisposable) {
      return `public async destroy(): Promise<void> {
    ${lines.join('\n    ')}
  }`;
    }

    return `public destroy(): Promise<void> {
    ${lines.join('\n    ')}
    return Promise.resolve();
  }`;
  }

  const close = hasAsyncDisposable
    ? `private async _close(): Promise<void> {
    ${lines.join('\n    ')}
  }`
    : `private _close(): void {
    ${lines.join('\n    ')}
  }`;
  const finish = hasAsyncDisposable ? 'await this._close();' : 'this._close();';
  const head = hasAsyncDisposable
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
