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
 * Cache key shared by resolveAll, initialize and destroy.
 * Hand-built graphs omit registrationId and keep the token:index fallback.
 * The index keeps two contributions that share one registrationId apart.
 */
export function multiRegistrationKey(node: DependencyNode, tokenId: TokenId, index: number): string {
  const registrationId = node.service.registrationId;
  if (registrationId) return JSON.stringify(`${registrationId}#${index}`);
  return JSON.stringify(`${tokenId}:${index}`);
}

/** Accessor names of the optimized emitter. `base` is a sanitized token id, plus `_<index>` for a contribution. */
export function getDirectName(tokenId: TokenId, index?: number): string {
  const base = tokenId.replace(FACTORY_NAME_SANITIZER, '_');
  return index === undefined ? `_direct_${base}` : `_direct_${base}_${index}`;
}

/** Same as {@link getDirectName}, plus the resolve notification of the full profile. */
export function getReadName(tokenId: TokenId): string {
  return `_get_${tokenId.replace(FACTORY_NAME_SANITIZER, '_')}`;
}

/**
 * Optimized emitter only. A dependency registered in this container is read through
 * its own accessor instead of the generic resolver. `notify` keeps the full-profile
 * resolve event on every internal read (ADR005, "Événement resolve").
 */
export interface DirectReads {
  notify: boolean;
}

function directRead(tokenId: TokenId, direct: DirectReads): string {
  return direct.notify ? `this.${getReadName(tokenId)}()` : `this.${getDirectName(tokenId)}()`;
}

function isLocalRegistration(graph: DependencyGraph, tokenId: TokenId): boolean {
  const node = graph.nodes.get(tokenId);
  return node !== undefined && node.service.type !== 'parent';
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
function resolutionCalls(hasAsync: boolean, closed = false): { one: string; all: string } {
  // Closed sync factories must not call the public resolve. ADR006 lines 29-33.
  return hasAsync || closed
    ? { one: 'this._resolveInternal', all: 'this._resolveAllInternal' }
    : { one: 'this.resolve', all: 'this.resolveAll' };
}

export function resolveConstructorArgs(
  dependencies: TokenId[],
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync = false,
  closed = false,
  direct?: DirectReads,
): string {
  const read = resolutionCalls(hasAsync, closed || direct !== undefined).one;
  return dependencies.map(depId => {
    const depNode = graph.nodes.get(depId);
    if (direct && isLocalRegistration(graph, depId)) return directRead(depId, direct);
    if (!depNode) {
      // Not registered locally — check whether it's satisfied by a parent/legacy
      // container (see DependencyGraph.parentResolvableTokens for why only this
      // subset of parent-provided tokens is safe to wire this way via a string key).
      if (graph.parentResolvableTokens?.has(depId)) {
        return `${read}(${JSON.stringify(depId)})`;
      }
      // A bare class token from the parent: resolved by class identity, not by
      // string, so we need the actual class reference — see parentClassTokenSymbols.
      const classSymbol = graph.parentClassTokenSymbols?.get(depId);
      if (classSymbol) {
        return `${read}(${getForeignImport(classSymbol)})`;
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
      return `${read}(${JSON.stringify(depNode.service.tokenId)})`;
    } else if (depNode.service.tokenSymbol) {
      return `${read}(${getImport(depNode.service.tokenSymbol)})`;
    } else if (depNode.service.implementationSymbol) {
      return `${read}(${getImport(depNode.service.implementationSymbol)})`;
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
): { entries: Array<[string, boolean]>; skipWarm: Map<string, boolean>; locals: Map<string, TokenId> } {
  const flags = new Map<string, boolean>();
  const skipWarm = new Map<string, boolean>();
  const locals = new Map<string, TokenId>();
  for (const dep of service.factoryDependencies ?? []) {
    const key = dependencyKeyExpression(dep, graph, getImport);
    if (isLocalRegistration(graph, dep.tokenId)) locals.set(key, dep.tokenId);
    const previous = flags.get(key);
    const allFlag = previous || dep.all;
    flags.set(key, allFlag);
    const transientDep = isTransientDependency(dep, graph);
    const already = skipWarm.get(key);
    skipWarm.set(key, already === undefined ? transientDep : already && transientDep);
  }
  return { entries: [...flags.entries()], skipWarm, locals };
}

/**
 * Optimized emitter only. `ctx.resolve` reaches a declared local provider through its own
 * accessor. The generic resolver is called only for a declared token that is not a local
 * single registration (a parent token, a multi token). A factory with no such token has none.
 */
function directContextResolve(
  listed: ReturnType<typeof factoryAllowList>,
  direct: DirectReads,
  fallback: string,
): string {
  const locals = [...listed.locals.entries()];
  const hasOther = listed.entries.some(([key]) => !listed.locals.has(key));
  if (locals.length === 0 && !hasOther) return 'return undefined;';
  const lines = locals.map(([key, tokenId], index) => {
    const read = `return ${directRead(tokenId, direct)};`;
    return !hasOther && index === locals.length - 1 ? read : `if (token === ${key}) ${read}`;
  });
  if (hasOther) lines.push(`return ${fallback}(token);`);
  return lines.join('\n        ');
}

/**
 * What the factory contexts of a graph still need from the generic resolvers.
 * `opaque`: an opaque factory may ask for any token. `multiAll`: multi tokens a declared
 * factory dependency reads with resolveAll.
 */
export function factoryContextNeeds(graph: DependencyGraph): { opaque: boolean; multiAll: Set<TokenId> } {
  const needs = { opaque: false, multiAll: new Set<TokenId>() };
  const visit = (service: DependencyNode['service']): void => {
    if (service.type !== 'factory' || !service.factorySource) return;
    if (service.opaque === true) needs.opaque = true;
    for (const dep of service.factoryDependencies ?? []) {
      if (dep.all && graph.multiNodes?.has(dep.tokenId)) needs.multiAll.add(dep.tokenId);
    }
  };
  for (const node of graph.nodes.values()) visit(node.service);
  for (const nodes of graph.multiNodes?.values() ?? []) nodes.forEach((node) => visit(node.service));
  return needs;
}

/** A sync throw from warmup or from the factory must expire the context before it escapes. */
function emitInvocation(warmup: string, release: string): string {
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
  return `try {
    ${warmup}
    ${resultBlock}
  } catch (__neoThrown) { __neoExpire(); ${release} throw __neoThrown; }`;
}

function emitFactoryBody(
  service: DependencyNode['service'],
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
  closed = false,
  direct?: DirectReads,
): string {
  const userFactory = service.factorySource ?? 'undefined';
  const label = JSON.stringify(getSimpleName(service.tokenId));
  const opaqueFactory = service.opaque === true;
  const listed = factoryAllowList(service, graph, getImport);
  const allowed = listed.entries;
  const entries = allowed.map(([key, all]) => `[${key}, ${all ? '"all"' : '"simple"'}]`).join(', ');
  const calls = resolutionCalls(hasAsync, closed || direct !== undefined);
  const warmupLines: string[] = [];
  if (!opaqueFactory) {
    for (const [key, all] of allowed) {
      const depIsTransient = listed.skipWarm.get(key) === true;
      if (depIsTransient) continue;
      const local = listed.locals.get(key);
      if (direct && local !== undefined && !all) {
        warmupLines.push(`${directRead(local, direct)};`);
        continue;
      }
      warmupLines.push(all ? `${calls.all}(${key});` : `${calls.one}(${key});`);
    }
  }
  const warmup = warmupLines.join('\n    ');
  const resolveTail = direct ? directContextResolve(listed, direct, calls.one) : `return ${calls.one}(token);`;
  const resolveAllTail = direct && !allowed.some(([, all]) => all) ? 'return undefined;' : `return ${calls.all}(token);`;
  const holdStart = '';
  const release = '';
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
        return ${calls.one}(token);
      },
      resolveAll: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        return ${calls.all}(token);
      },
    };
    ${holdStart}
    ${emitInvocation('', release)}`;
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
        ${resolveTail}
      },
      resolveAll: (token) => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        if (__neoAllowed.get(token) !== 'all') __neoFail('NEO_UNDECLARED_FACTORY_DEP', 'cannot resolveAll an undeclared dependency');
        ${resolveAllTail}
      },
    };
    ${holdStart}
    ${emitInvocation(warmup, release)}`;
}

/** A captured useValue is read once. Hand-built graphs keep the original expression. */
function capturedValue(node: DependencyNode): string {
  return node.service.valueCapture ?? node.service.valueSource ?? 'undefined';
}

/** Generates a factory method for each service in topological order. */
export function generateFactories(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync = false,
  closed = false,
  direct?: DirectReads,
): string[] {
  const factories: string[] = [];

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    if (node.service.type === 'parent') continue;

    const factoryId = getFactoryName(tokenId);

    if (node.service.type === 'value' && node.service.valueSource !== undefined) {
      factories.push(`
  private ${factoryId}(): any {
    return ${capturedValue(node)};
  }`);
      continue;
    }

    if (node.service.type === 'factory' && node.service.factorySource) {
      const body = emitFactoryBody(node.service, graph, getImport, hasAsync, closed, direct);
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
      const args = resolveConstructorArgs(node.dependencies, graph, getImport, getForeignImport, hasAsync, closed, direct);

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
  getForeignImport: GetImport,
  hasAsync = false,
  closed = false,
  direct?: DirectReads,
): string[] {
  const factories: string[] = [];
  if (!graph.multiNodes) return factories;

  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${getFactoryName(tokenId)}_${index}`;

      if (node.service.type === 'factory' && node.service.factorySource) {
        const body = emitFactoryBody(node.service, graph, getImport, hasAsync, closed, direct);
        factories.push(`
  private ${factoryId}(): any {
    ${body}
  }`);
      } else if (node.service.type === 'value' && node.service.valueSource !== undefined) {
        factories.push(`
  private ${factoryId}(): any {
    return ${capturedValue(node)};
  }`);
      } else {
        if (!node.service.implementationSymbol) return;
        const className = getImport(node.service.implementationSymbol);
        const args = resolveConstructorArgs(node.dependencies, graph, getImport, getForeignImport, hasAsync, closed, direct);
        factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }
    });
  }

  return factories;
}
