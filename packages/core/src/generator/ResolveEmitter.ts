import type { DependencyGraph, DependencyNode, TokenId } from '../analyzer/types';
import { getFactoryName, multiRegistrationKey, resolveTokenKey, type GetImport } from './FactoryEmitter';

/**
 * Returns the guard statement injected at the top of resolve() and resolveAll()
 * when the container has async services that require initialization before use.
 * Returns an empty string when `hasAsync` is false.
 */
export function buildAsyncResolveGuard(hasAsync: boolean): string {
  if (!hasAsync) return '';
  return 'this._guardPublic();';
}

/** resolve() on a multi token is refused. Sync containers have no _neoFail helper. */
export function generateMultiResolveGuard(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
): string {
  if (!graph.multiNodes || graph.multiNodes.size === 0) return '';
  const checks: string[] = [];
  for (const nodes of graph.multiNodes.values()) {
    const tokenKey = resolveTokenKey(nodes[0].service, getImport);
    if (hasAsync) {
      checks.push(`if (token === ${tokenKey}) { throw this._neoFail('NEO_MULTI_REQUIRES_RESOLVE_ALL', 'use resolveAll'); }`);
    } else {
      checks.push(`if (token === ${tokenKey}) { const __neoMulti = new Error('NEO_MULTI_REQUIRES_RESOLVE_ALL: [' + this.name + '] use resolveAll') as Error & { code: string }; __neoMulti.code = 'NEO_MULTI_REQUIRES_RESOLVE_ALL'; throw __neoMulti; }`);
    }
  }
  return checks.join('\n    ');
}

/** Generates resolve switch cases for each service in topological order. */
export function generateResolveCases(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync = false,
  formatToken = 'String',
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
    const asyncSingleton = hasAsync && !!node.service.isAsync && !isTransient;

    const creationLogic = isTransient
      ? `return this.${factoryId}();`
      : asyncSingleton
        ? `
            if (!this.instances.has(${tokenKey})) {
                throw new Error('async singleton is not prepared: ' + ${formatToken}(token));
            }
            return this.instances.get(${tokenKey});
          `
        : hasAsync
          ? `
            if (!this.instances.has(${tokenKey})) {
                const instance = this.${factoryId}();
                this.instances.set(${tokenKey}, instance);
                if (this._initRunning) this._initJournal.push(${tokenKey});
                return instance;
            }
            return this.instances.get(${tokenKey});
          `
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

function contributionCall(
  node: DependencyNode,
  tokenId: TokenId,
  index: number,
  factoryBase: string,
  hasAsync: boolean,
): string {
  const factoryId = `${factoryBase}_${index}`;
  if (node.service.lifecycle === 'transient') {
    return `this.${factoryId}()`;
  }
  const key = multiRegistrationKey(node, tokenId, index);
  if (hasAsync && node.service.isAsync) {
    return `this.instances.get(${key})`;
  }
  if (hasAsync) {
    return `(() => { const k = ${key}; if (!this.instances.has(k)) { const inst = this.${factoryId}(); this.instances.set(k, inst); if (this._initRunning) this._initJournal.push(k); } return this.instances.get(k); })()`;
  }
  return `(() => { const k = ${key}; if (!this.instances.has(k)) { const inst = this.${factoryId}(); this.instances.set(k, inst); } return this.instances.get(k); })()`;
}

function freshList(expr: string): string {
  return `{ const __neoAll = [${expr}]; return __neoAll.slice(); }`;
}

function legacyResolveAll(): string {
  return `if (this.legacy) {
      for (const __neoLegacy of this.legacy) {
        if (typeof __neoLegacy?.resolveAll === 'function') {
          const __neoListed = __neoLegacy.resolveAll(token);
          if (Array.isArray(__neoListed)) return __neoListed.slice();
        }
      }
    }
    return [];`;
}

/** Generates the resolveAll() method with one branch per multi-token. */
export function generateResolveAllMethod(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean
): string {
  const tail = legacyResolveAll();
  if (!graph.multiNodes || graph.multiNodes.size === 0) {
    if (!hasAsync) {
      return `public resolveAll<T>(token: any): T[] {
    ${tail}
  }`;
    }
    return `public resolveAll<T>(token: any): T[] {
    this._guardPublic('resolveAll()');
    return this._resolveAllInternal<T>(token);
  }

  private _resolveAllInternal<T>(token: any): T[] {
    ${tail}
  }`;
  }

  const cases: string[] = [];

  for (const [tokenId, nodes] of graph.multiNodes) {
    const contributions = nodes;
    const tokenKey = resolveTokenKey(contributions[0].service, getImport);
    const tokenCheck = `if (token === ${tokenKey})`;
    const factoryBase = getFactoryName(tokenId);
    const callExprs = contributions.map((node, index) => contributionCall(node, tokenId, index, factoryBase, hasAsync));
    cases.push(`${tokenCheck} ${freshList(callExprs.join(', '))}`);
  }

  if (!hasAsync) {
    return `public resolveAll<T>(token: any): T[] {
    ${cases.join('\n    ')}
    ${tail}
  }`;
  }

  return `public resolveAll<T>(token: any): T[] {
    this._guardPublic('resolveAll()');
    return this._resolveAllInternal<T>(token);
  }

  private _resolveAllInternal<T>(token: any): T[] {
    ${cases.join('\n    ')}
    ${tail}
  }`;
}
