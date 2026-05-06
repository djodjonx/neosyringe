import type { DependencyGraph, TokenId } from '../analyzer/types';
import { getFactoryName, type GetImport } from './FactoryEmitter';

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

    let tokenKey: string;
    let tokenCheck: string;

    if (node.service.isInterfaceToken) {
      tokenKey = JSON.stringify(node.service.tokenId);
      tokenCheck = `if (token === ${JSON.stringify(node.service.tokenId)})`;
    } else if (node.service.tokenSymbol) {
      const tokenClass = getImport(node.service.tokenSymbol);
      tokenKey = tokenClass;
      tokenCheck = `if (token === ${tokenClass})`;
    } else if (node.service.implementationSymbol) {
      const className = getImport(node.service.implementationSymbol);
      tokenKey = className;
      tokenCheck = `if (token === ${className})`;
    } else {
      tokenKey = JSON.stringify(node.service.tokenId);
      tokenCheck = `if (token === ${JSON.stringify(node.service.tokenId)})`;
    }

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
  resolveGuard: string
): string {
  if (!graph.multiNodes || graph.multiNodes.size === 0) {
    return `public resolveAll<T>(token: any): T[] { return []; }`;
  }

  const cases: string[] = [];

  for (const [tokenId, nodes] of graph.multiNodes) {
    const firstNode = nodes[0];
    let tokenCheck: string;

    if (firstNode.service.isInterfaceToken) {
      tokenCheck = `if (token === ${JSON.stringify(firstNode.service.tokenId)})`;
    } else if (firstNode.service.tokenSymbol) {
      tokenCheck = `if (token === ${getImport(firstNode.service.tokenSymbol)})`;
    } else {
      tokenCheck = `if (token === ${JSON.stringify(firstNode.service.tokenId)})`;
    }

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
