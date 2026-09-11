import type * as ts from 'typescript';
import type { DependencyGraph, DependencyNode, TokenId } from '../analyzer/types';
import { FACTORY_NAME_SANITIZER } from '../analyzer/shared/constants';
import { getSimpleName } from '../analyzer/utils/TokenUtils';

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

/**
 * Resolves constructor argument expressions for a list of dependency token IDs.
 *
 * @param getForeignImport - Like `getImport`, but always emits an explicit
 *   namespace import regardless of default/named export status. Required for
 *   a parent-provided class token: unlike the child's own local dependencies
 *   (which the child file necessarily already imports, since the user wrote
 *   `{ token: X }` there themselves), a class living in the parent's file is
 *   not guaranteed to be in scope in the child's file at all.
 */
export function resolveConstructorArgs(
  dependencies: TokenId[],
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport
): string {
  return dependencies.map(depId => {
    const depNode = graph.nodes.get(depId);
    if (!depNode) {
      // Not registered locally — check whether it's satisfied by a parent/legacy
      // container (see DependencyGraph.parentResolvableTokens for why only this
      // subset of parent-provided tokens is safe to wire this way via a string key).
      if (graph.parentResolvableTokens?.has(depId)) {
        return `this.resolve(${JSON.stringify(depId)})`;
      }
      // A bare class token from the parent: resolved by class identity, not by
      // string, so we need the actual class reference — see parentClassTokenSymbols.
      const classSymbol = graph.parentClassTokenSymbols?.get(depId);
      if (classSymbol) {
        return `this.resolve(${getForeignImport(classSymbol)})`;
      }
      if (graph.parentProvidedTokens?.has(depId)) {
        // GraphValidator considers this dependency satisfied, but no symbol could
        // be captured for it (should not normally happen) — fail the build instead
        // of shipping a silently broken `undefined`.
        throw new Error(
          `[Generator] Cannot wire dependency '${getSimpleName(depId)}' from a parent/legacy container: ` +
          `it is registered as a class-based (non-interface) token there, and no symbol could be ` +
          `captured to reference it from here. Register '${getSimpleName(depId)}' with ` +
          `useInterface<...>() in the parent container, or register it directly in this container.`
        );
      }
      return 'undefined';
    }

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

/**
 * Resolves a service's runtime token key expression for use in generated code.
 * This is the value used as both the Map key (for instance caching) and the
 * token argument to `resolve()`.
 */
export function resolveTokenKey(service: DependencyNode['service'], getImport: GetImport): string {
  if (service.isInterfaceToken) return JSON.stringify(service.tokenId);
  if (service.tokenSymbol) return getImport(service.tokenSymbol);
  if (service.implementationSymbol) return getImport(service.implementationSymbol);
  return JSON.stringify(service.tokenId);
}

/** Generates a factory method for each service in topological order. */
export function generateFactories(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  getForeignImport: GetImport
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
      const args = resolveConstructorArgs(node.dependencies, graph, getImport, getForeignImport);

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
  getImport: GetImport,
  getForeignImport: GetImport
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
        const args = resolveConstructorArgs(node.dependencies, graph, getImport, getForeignImport);
        factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }
    });
  }

  return factories;
}
