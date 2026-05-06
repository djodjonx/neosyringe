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
 * in topological order. Only called when hasAsyncFactories() is true.
 */
export function generateInitializeMethod(graph: DependencyGraph, sorted: TokenId[]): string {
  const asyncSingletons = sorted.filter(tokenId => {
    const node = graph.nodes.get(tokenId);
    return node?.service.isAsync && node.service.lifecycle === 'singleton';
  });

  const lines = asyncSingletons.map(tokenId => {
    const factoryId = getFactoryName(tokenId);
    return `this.instances.set(${JSON.stringify(tokenId)}, await this.${factoryId}());`;
  });

  return `public async initialize(): Promise<void> {
    if (this._initialized) return;
    ${lines.join('\n    ')}
    this._initialized = true;
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
  getImport: GetImport
): string {
  const hasAsyncFactory = hasAsyncFactories(graph);
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
  if (hasAsyncFactory) lines.push('this._initialized = false;');
  for (const { tokenKey, isAsync } of disposables) {
    const call = isAsync
      ? `await (this.instances.get(${tokenKey}) as any).dispose();`
      : `(this.instances.get(${tokenKey}) as any).dispose();`;
    lines.push(`if (this.instances.has(${tokenKey})) { ${call} }`);
  }
  lines.push('this.instances.clear();');

  const asyncKw = hasAsyncDisposable ? 'async ' : '';
  const ret = hasAsyncDisposable ? 'Promise<void>' : 'void';
  return `public ${asyncKw}destroy(): ${ret} {
    ${lines.join('\n    ')}
  }`;
}
