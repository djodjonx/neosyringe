import type * as ts from 'typescript';
import type { DependencyGraph, TokenId } from '../analyzer/types';
import { FACTORY_NAME_SANITIZER } from '../analyzer/shared/constants';

/**
 * Resolves a TypeScript symbol to a string reference usable in generated code.
 *
 * In direct-symbol mode (unplugin transform), this is just the symbol's name.
 * In imports mode (separate output file), this is `Import_N.SymbolName`.
 */
export type GetImport = (symbol: ts.Symbol) => string;

/**
 * Creates a valid JavaScript function name from a token ID.
 * @param tokenId - The token identifier.
 * @returns A sanitized factory function name.
 */
export function getFactoryName(tokenId: TokenId): string {
  return `create_${tokenId.replace(FACTORY_NAME_SANITIZER, '_')}`;
}

/** Resolves constructor argument expressions for a list of dependency token IDs. */
export function resolveConstructorArgs(
  dependencies: TokenId[],
  graph: DependencyGraph,
  getImport: GetImport
): string {
  return dependencies.map(depId => {
    const depNode = graph.nodes.get(depId);
    if (!depNode) return 'undefined';

    if (depNode.service.isInterfaceToken) {
      return `this.resolve(${JSON.stringify(depNode.service.tokenId)})`;
    } else if (depNode.service.tokenSymbol) {
      return `this.resolve(${getImport(depNode.service.tokenSymbol)})`;
    } else if (depNode.service.implementationSymbol) {
      return `this.resolve(${getImport(depNode.service.implementationSymbol)})`;
    }
    return 'undefined';
  }).join(', ');
}

/** Generates a factory method for each service in topological order. */
export function generateFactories(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport
): string[] {
  const factories: string[] = [];

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    if (node.service.type === 'parent') continue;

    const factoryId = getFactoryName(tokenId);

    if (node.service.type === 'value' && node.service.valueSource !== undefined) {
      // Value provider: embed the source expression directly
      factories.push(`
  private ${factoryId}(): any {
    return ${node.service.valueSource};
  }`);
      continue;
    }

    if (node.service.type === 'factory' && node.service.factorySource) {
      const userFactory = node.service.factorySource;
      factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${userFactory};
    return userFactory(this);
  }`);
    } else {
      if (!node.service.implementationSymbol) {
        throw new Error(
          `[Generator] No implementation symbol for token '${tokenId}'. ` +
          `This is likely a bug — ensure all non-factory registrations have a provider class.`
        );
      }
      const className = getImport(node.service.implementationSymbol);
      const args = resolveConstructorArgs(node.dependencies, graph, getImport);

      factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
    }
  }

  return factories;
}

/** Generates indexed factory methods for multi-registration nodes. */
export function generateMultiFactories(
  graph: DependencyGraph,
  getImport: GetImport
): string[] {
  const factories: string[] = [];
  if (!graph.multiNodes) return factories;

  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${getFactoryName(tokenId)}_${index}`;

      if (node.service.type === 'factory' && node.service.factorySource) {
        factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${node.service.factorySource};
    return userFactory(this);
  }`);
      } else if (node.service.type === 'value' && node.service.valueSource !== undefined) {
        factories.push(`
  private ${factoryId}(): any {
    return ${node.service.valueSource};
  }`);
      } else {
        if (!node.service.implementationSymbol) return;
        const className = getImport(node.service.implementationSymbol);
        const args = resolveConstructorArgs(node.dependencies, graph, getImport);
        factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }
    });
  }

  return factories;
}
