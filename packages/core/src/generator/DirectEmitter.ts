import type { DependencyGraph, TokenId } from '../analyzer/types';
import {
  generateFactories,
  generateMultiFactories,
  getReadName,
  getDirectName,
  factoryContextNeeds,
  resolveTokenKey,
  type DirectReads,
  type GetImport,
} from './FactoryEmitter';
import {
  generateDirectAccessors,
  generateDirectContributions,
  generateDirectResolveAll,
  generateMultiResolveGuard,
  parentOpenCheck,
} from './ResolveEmitter';
import {
  generateCreateScopeMethod,
  generateDestroyMethod,
  generateEagerSyncInitialize,
  generateInitializeMethod,
  generateOverrideMethods,
  generateSyncInitializeMethod,
} from './LifecycleEmitter';

/**
 * Everything the optimized emitter needs from {@link Generator}. The strings are the
 * members both emitters share (state fields, helpers, debug getters), rendered once there.
 */
export interface OptimizedContainerInput {
  /** The retained graph. Pruned providers must not appear in any member below. */
  graph: DependencyGraph;
  sorted: TokenId[];
  getImport: GetImport;
  getForeignImport: GetImport;
  hasAsync: boolean;
  closed: boolean;
  /** Runtime profile. Minimal drops on(), override(), clearOverrides() and their state. */
  minimal: boolean;
  testOverrides: boolean;
  className: string;
  notFoundErrorClassName: string;
  eagerLines: string[];
  stateFields: string;
  rootFields: string;
  runtimeHelpers: string;
  assertRootMethod: string;
  debugGetters: string;
}

function mockMethod(): string {
  return `private _mock(token: any): any {
    if (!this.instances.has(token)) {
      const __neoMock = this.overrides.get(token)!();
      this.instances.set(token, __neoMock);
      if (__neoMock != null) this._borrowed.add(__neoMock);
    }
    return this.instances.get(token);
  }`;
}

function eventMembers(): string {
  return `/**
   * Subscribes to container events — currently only 'resolve', fired with the
   * token and the resolved instance every time resolve() succeeds (whether
   * served from cache, freshly created, an override, or a parent/legacy
   * container). Returns an unsubscribe function. A listener that throws is
   * caught and ignored.
   */
  public on(event: 'resolve', listener: (token: any, instance: any) => void): () => void {
    this.resolveListeners.add(listener);
    return () => { this.resolveListeners.delete(listener); };
  }

  private notifyResolve(token: any, instance: any): void {
    for (const listener of this.resolveListeners) {
      try {
        listener(token, instance);
      } catch {
        // A listener's own bug must never break the resolution it's observing.
      }
    }
  }`;
}

function formatTokenMember(): string {
  return `private static formatToken(token: any): string {
    if (typeof token === 'function') return token.name || String(token);
    if (typeof token !== 'string') return String(token);
    const parts = token.split('_');
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^[a-f0-9]{6,12}$/i.test(last)) {
      return parts.slice(0, -1).join('_');
    }
    return token;
  }`;
}

/** Delegation to a useContainer parent, then the not-found error. Shared by both resolvers. */
function legacyAndNotFound(input: OptimizedContainerInput): string {
  const notify = input.minimal ? '' : '\n                    this.notifyResolve(token, legacyResult);';
  return `if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) {
                    const legacyResult = legacyContainer.resolve(token);
                    if (legacyResult != null) this._borrowed.add(legacyResult);${notify}
                    return legacyResult;
                }
            } catch (e: any) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${input.notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${input.className}.formatToken(token)}\`);`;
}

/** One case per retained provider. A pruned provider has no case, no accessor, no key. */
function resolveCases(input: OptimizedContainerInput, ids: Iterable<TokenId>): string {
  const cases: string[] = [];
  for (const tokenId of ids) {
    const node = input.graph.nodes.get(tokenId);
    if (!node || node.service.type === 'parent') continue;
    const access = input.minimal ? getDirectName(tokenId) : getReadName(tokenId);
    cases.push(`if (token === ${resolveTokenKey(node.service, input.getImport)}) return this.${access}();`);
  }
  return cases.join('\n    ');
}

function overrideBlock(input: OptimizedContainerInput): string {
  if (input.minimal || !input.testOverrides) return '';
  return `// An overridden token always wins, even over a cached real instance.
    if (this.overrides.has(token)) {
      const overridden = this._mock(token);
      this.notifyResolve(token, overridden);
      return overridden;
    }`;
}

function resolveInterior(input: OptimizedContainerInput, cases: string, multiGuard: string): string {
  return `${parentOpenCheck(input.hasAsync, input.minimal)}
    ${multiGuard}
    ${overrideBlock(input)}
    ${cases}
    ${legacyAndNotFound(input)}`;
}

/**
 * Public resolve plus the internal dispatcher.
 * Open: `_resolveInternal` lists every local provider.
 * Closed: `resolve` lists the exported roots only and never reaches the generic dispatcher.
 * The dispatcher lists a local provider only when an opaque factory may ask for any token;
 * otherwise it serves parent tokens alone, a declared local dependency has its own accessor.
 */
function resolveMethods(input: OptimizedContainerInput, listLocals: boolean): { publicMethod: string; internalMethod: string } {
  const guard = input.hasAsync ? 'this._guardPublic();\n    ' : '';
  const multiGuard = generateMultiResolveGuard(input.graph, input.getImport, input.hasAsync);
  const internalMethod = `private _resolveInternal<T>(token: any): T {
    ${resolveInterior(input, resolveCases(input, listLocals ? input.sorted : []), multiGuard)}
  }`;
  if (!input.closed) {
    return {
      publicMethod: `public resolve<T>(token: any): T {
    ${guard}return this._resolveInternal<T>(token);
  }`,
      internalMethod,
    };
  }
  const roots = input.graph.publicRoots ?? [];
  return {
    publicMethod: `public resolve<T>(token: any): T {
    ${guard}this._assertRoot(token, false);
    ${resolveInterior(input, resolveCases(input, roots), '')}
  }`,
    internalMethod,
  };
}

/**
 * Optimized container class. The reference emitter in {@link Generator} stays the
 * witness (ADR007, "Comparaisons et instrumentation"); this one emits an accessor per
 * registration that calls its dependencies directly, with the state of one container
 * or scope in `instances`.
 *
 * Full profile: same events, overrides and invalidation as the reference.
 * Minimal profile: CoreContainer only. No on/override/clearOverrides, no overrides map,
 * no listeners, no notify branch. Destroy, initialize and createScope are unchanged.
 */
export function emitOptimizedContainer(input: OptimizedContainerInput): string {
  const { graph, sorted, getImport, getForeignImport, hasAsync, closed, minimal } = input;
  const direct: DirectReads = { notify: !minimal };
  const honourOverrides = !minimal && input.testOverrides;
  const creators = [
    ...generateFactories(graph, sorted, getImport, getForeignImport, hasAsync, closed, direct),
    ...generateMultiFactories(graph, getImport, getForeignImport, hasAsync, closed, direct),
  ];
  const accessors = [
    ...generateDirectAccessors(graph, sorted, getImport, hasAsync, { minimal, honourOverrides }, `${input.className}.formatToken`),
    ...generateDirectContributions(graph, hasAsync),
  ];
  const needs = factoryContextNeeds(graph);
  const listLocals = !closed || needs.opaque;
  const resolve = resolveMethods(input, listLocals);
  const resolveAll = generateDirectResolveAll(graph, getImport, hasAsync, closed, minimal, listLocals ? undefined : needs.multiAll);

  // Closed: a generic dispatcher exists only when a parent token, a declared multi token or an
  // opaque factory still has to be reached by token. A factory with no such need has none.
  const creatorText = creators.join('\n');
  const needsInternalResolve = !closed || creatorText.includes('this._resolveInternal(');
  const needsInternalResolveAll = !closed || creatorText.includes('this._resolveAllInternal(');

  const initialize = hasAsync
    ? generateInitializeMethod(graph, sorted, getImport, hasAsync, input.eagerLines, minimal)
    : input.eagerLines.length > 0
      ? generateEagerSyncInitialize(input.eagerLines, minimal)
      : generateSyncInitializeMethod(minimal);
  const destroy = generateDestroyMethod(graph, sorted, getImport, hasAsync, minimal);
  const tableFields = minimal
    ? ''
    : `\n  private overrides = new Map<any, () => any>();\n  private resolveListeners = new Set<(token: any, instance: any) => void>();`;
  const members: string[] = [
    input.runtimeHelpers + input.assertRootMethod,
    initialize,
    generateCreateScopeMethod(input.className, hasAsync, minimal),
  ];
  if (!minimal) {
    members.push(generateOverrideMethods(graph, sorted, getImport, hasAsync, input.testOverrides));
    members.push(eventMembers());
  }
  if (honourOverrides) members.push(mockMethod());
  members.push(resolve.publicMethod);
  if (needsInternalResolve) members.push(resolve.internalMethod);
  members.push(formatTokenMember(), destroy, resolveAll.publicMethod);
  if (needsInternalResolveAll) members.push(resolveAll.internalMethod);
  members.push(input.debugGetters);

  return `class ${input.notFoundErrorClassName} extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class ${input.className} {
  private instances = new Map<any, any>();${tableFields}
  ${input.stateFields}${input.rootFields}

  // -- Factories --
  ${creators.join('\n  ')}

  // -- Accessors --
  ${accessors.join('\n  ')}

  constructor(
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  ${members.join('\n\n  ')}
}`;
}
