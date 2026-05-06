import type { DependencyGraph, TokenId } from '../analyzer/types';
import { getFactoryName, resolveTokenKey, type GetImport } from './FactoryEmitter';

/**
 * Returns the guard statement injected at the top of resolve() and resolveAll()
 * when the container has async services that require initialization before use.
 * Returns an empty string when `hasAsync` is false.
 */
export function buildAsyncResolveGuard(hasAsync: boolean): string {
  if (!hasAsync) return '';
  return `if (!this._initialized) { throw new Error(\`[\${this.name}] This container has async services — call \\\`await container.initialize()\\\` before the first resolve().\`); }`;
}

/** Generates resolve switch cases for each service in topological order. */
export function generateResolveCases(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport
): string[] {
  const resolveCases: string[] = [];

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    if (node.service.type === 'parent') continue;

    const factoryId = getFactoryName(tokenId);
    const isTransient = node.service.lifecycle === 'transient';
    const tokenKey = resolveTokenKey(node.service, getImport);
    const tokenCheck = `if (token === ${tokenKey})`;

    const creationLogic = isTransient
      ? `return this.${factoryId}();`
      : `
            if (!this.instances.has(${tokenKey})) {
                const instance = this.${factoryId}();
                this.instances.set(${tokenKey}, instance);
                return instance;
            }
            return this.instances.get(${tokenKey});
          `;

    resolveCases.push(`${tokenCheck} { ${creationLogic} }`);
  }

  return resolveCases;
}

/** Generates the resolveAll() method with one branch per multi-token. */
export function generateResolveAllMethod(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean
): string {
  if (!graph.multiNodes || graph.multiNodes.size === 0) {
    return `public resolveAll<T>(token: any): T[] { return []; }`;
  }

  const resolveGuard = buildAsyncResolveGuard(hasAsync);

  const cases: string[] = [];

  for (const [tokenId, nodes] of graph.multiNodes) {
    const firstNode = nodes[0];
    const tokenKey = resolveTokenKey(firstNode.service, getImport);
    const tokenCheck = `if (token === ${tokenKey})`;

    const isTransient = firstNode.service.lifecycle === 'transient';
    const factoryBase = getFactoryName(tokenId);

    let callExprs: string[];
    if (isTransient) {
      callExprs = nodes.map((_, i) => `this.${factoryBase}_${i}()`);
    } else {
      callExprs = nodes.map((_, i) => {
        const cacheKey = JSON.stringify(`${tokenId}:${i}`);
        return `(() => { const k = ${cacheKey}; if (!this.instances.has(k)) { const inst = this.${factoryBase}_${i}(); this.instances.set(k, inst); return inst; } return this.instances.get(k); })()`;
      });
    }

    cases.push(`${tokenCheck} return [${callExprs.join(', ')}] as T[];`);
  }

  return `public resolveAll<T>(token: any): T[] {
    ${resolveGuard}
    ${cases.join('\n    ')}
    return [];
  }`;
}
