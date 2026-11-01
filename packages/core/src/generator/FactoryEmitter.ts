import type * as ts from 'typescript';
import type { DependencyGraph, DependencyNode, FactoryDependency, TokenId } from '../analyzer/types';
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

    if (depNode.service.isInterfaceToken || depNode.service.isValueToken) {
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

function graphHasAsyncFactory(graph: DependencyGraph): boolean {
  for (const node of graph.nodes.values()) {
    if (node.service.isAsync) return true;
  }
  if (!graph.multiNodes) return false;
  for (const nodes of graph.multiNodes.values()) {
    if (nodes.some((node) => node.service.isAsync)) return true;
  }
  return false;
}

function dependencyKeyExpression(dep: FactoryDependency, graph: DependencyGraph, getImport: GetImport): string {
  const service = graph.nodes.get(dep.tokenId)?.service ?? graph.multiNodes?.get(dep.tokenId)?.[0]?.service;
  if (service) return resolveTokenKey(service, getImport);
  return dep.source;
}

function isTransientDependency(dep: FactoryDependency, graph: DependencyGraph): boolean {
  const node = graph.nodes.get(dep.tokenId);
  if (node) return node.service.lifecycle === 'transient';
  const multi = graph.multiNodes?.get(dep.tokenId);
  if (!multi || multi.length === 0) return false;
  return multi.every((item) => item.service.lifecycle === 'transient');
}

function factoryAllowList(
  service: DependencyNode['service'],
  graph: DependencyGraph,
  getImport: GetImport,
): { entries: Array<[string, boolean]>; skipWarm: Map<string, boolean> } {
  const flags = new Map<string, boolean>();
  const skipWarm = new Map<string, boolean>();
  for (const dep of service.factoryDependencies ?? []) {
    const key = dependencyKeyExpression(dep, graph, getImport);
    const previous = flags.get(key);
    const allFlag = previous || dep.all;
    flags.set(key, allFlag);
    const transientDep = isTransientDependency(dep, graph);
    const already = skipWarm.get(key);
    skipWarm.set(key, already === undefined ? transientDep : already && transientDep);
  }
  return { entries: [...flags.entries()], skipWarm };
}

function emitInvocation(warmup: string, release: string, holdInitialized: boolean): string {
  const resultBlock = `const __neoResult = userFactory(__neoContext);
    if (__neoResult && typeof __neoResult.then === 'function') {
      return Promise.resolve(__neoResult).then(
        (value) => { __neoExpire(); ${release} return value; },
        (err) => { __neoExpire(); ${release} throw err; },
      );
    }
    __neoExpire();
    ${release}
    return __neoResult;`;
  const open = `${warmup}
    ${resultBlock}`;
  if (!holdInitialized) return open;
  return `try {
    ${open}
    } catch (__neoThrown) { __neoExpire(); ${release} throw __neoThrown; }`;
}

function emitFactoryBody(
  service: DependencyNode['service'],
  graph: DependencyGraph,
  getImport: GetImport,
  holdInitialized: boolean,
): string {
  const userFactory = service.factorySource ?? 'undefined';
  const label = JSON.stringify(getSimpleName(service.tokenId));
  const opaqueFactory = service.opaque === true;
  const listed = factoryAllowList(service, graph, getImport);
  const allowed = listed.entries;
  const entries = allowed.map(([key, all]) => `[${key}, ${all ? '"all"' : '"simple"'}]`).join(', ');
  const warmupLines: string[] = [];
  if (!opaqueFactory) {
    for (const [key, all] of allowed) {
      const depIsTransient = listed.skipWarm.get(key) === true;
      if (depIsTransient) continue;
      warmupLines.push(all ? `this.resolveAll(${key});` : `this.resolve(${key});`);
    }
  }
  const warmup = warmupLines.join('\n    ');
  const holdStart = holdInitialized
    ? 'const __neoHold = this._initialized === false;\n    if (__neoHold) this._initialized = true;'
    : '';
  const release = holdInitialized ? 'if (__neoHold) this._initialized = false;' : '';
  const expireStmt = 'const __neoExpire = () => { __neoExpired = true; };';
  const failStmt = `const __neoFail = (code, detail) => {
      const error = new Error(code + ': factory ' + ${label} + ' ' + detail);
      error.code = code;
      throw error;
    };`;
  if (opaqueFactory) {
    return `const userFactory = ${userFactory};
    let __neoExpired = false;
    ${expireStmt}
    ${failStmt}
    const __neoContext = {
      resolve: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        return this.resolve(token);
      },
      resolveAll: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        return this.resolveAll(token);
      },
    };
    ${holdStart}
    ${emitInvocation('', release, holdInitialized)}`;
  }
  return `const userFactory = ${userFactory};
    const __neoAllowed = new Map([${entries}]);
    let __neoExpired = false;
    ${expireStmt}
    ${failStmt}
    const __neoContext = {
      resolve: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        const mode = __neoAllowed.get(token);
        if (mode !== 'simple' && mode !== 'all') __neoFail('NEO_UNDECLARED_FACTORY_DEP', 'cannot resolve an undeclared dependency');
        return this.resolve(token);
      },
      resolveAll: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        if (__neoAllowed.get(token) !== 'all') __neoFail('NEO_UNDECLARED_FACTORY_DEP', 'cannot resolveAll an undeclared dependency');
        return this.resolveAll(token);
      },
    };
    ${holdStart}
    ${emitInvocation(warmup, release, holdInitialized)}`;
}

/** Generates a factory method for each service in topological order. */
export function generateFactories(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  getForeignImport: GetImport
): string[] {
  const factories: string[] = [];
  const holdInitialized = graphHasAsyncFactory(graph);

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
      const body = emitFactoryBody(node.service, graph, getImport, holdInitialized);
      factories.push(`
  private ${factoryId}(): any {
    ${body}
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
  const holdInitialized = graphHasAsyncFactory(graph);

  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${getFactoryName(tokenId)}_${index}`;

      if (node.service.type === 'factory' && node.service.factorySource) {
        const body = emitFactoryBody(node.service, graph, getImport, holdInitialized);
        factories.push(`
  private ${factoryId}(): any {
    ${body}
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
