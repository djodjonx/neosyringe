import type { DependencyGraph, TokenId } from '../analyzer/types';
import {
  concat,
  fragment,
  generatedCopy,
  generatedText,
  selectHelpers,
  withNeeds,
  type Fragment,
  type Helper,
  type Piece,
  type UserCopy,
} from './fragments';
import { dispatchIsLinear, emitDispatchField, emitDispatchRead, emitLinearRead, type DispatchEntry } from './dispatchEmitter';
import { factoryLeaseHelpers } from './factoryLeaseEmitter';
import { noProviderTypes, type GetProviderTypes } from './providerTypes';
import {
  constructionExpression,
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
  legacyParentInterface,
  type ListReader,
  parentOpenCheck,
  resolveListenerOverload,
  singleOverload,
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
  /** How a user expression enters the output. Absent: generated text, no copy. */
  copy?: UserCopy;
  /** Name of the generated interface that types the `useContainer` parents. Absent: `NeoLegacyParent`. */
  legacyParentName?: string;
  /** The type of each getter, from the provider. Absent: every getter answers `unknown`. */
  providerTypes?: GetProviderTypes;
  /** Rows up to which a dispatch table is the linear cases and not the shared table. Each table is counted on its own rows. */
  dispatchLinearMax: number;
}

/**
 * An override is a test double that stands for the registered type, so a typed accessor reads it as that type:
 * `_mock<T>` is an overload over an `unknown` body, the same contract as `resolve<T>`.
 */
function mockMethod(): string {
  return `private _mock<T>(token: unknown): T;
  private _mock(token: unknown): unknown {
    if (!this.instances.has(token)) {
      const __neoMock = this.overrides.get(token)!();
      this.instances.set(token, __neoMock);
      if (__neoMock != null) this._borrowed.add(__neoMock);
    }
    return this.instances.get(token);
  }`;
}

/**
 * `on()` of the full profile. In open mode a box starts on a listener set shared by every box of the class, which stays
 * empty: `on()` gives the box a set of its own before it adds the first listener.
 */
function eventMembers(className: string, sharedListeners: boolean): string {
  const own = sharedListeners
    ? `if (this.resolveListeners === ${className}.__neoNoListeners) this.resolveListeners = new Set();\n    `
    : '';
  return `/**
   * Subscribes to container events — currently only 'resolve', fired with the
   * token and the resolved instance every time resolve() succeeds (whether
   * served from cache, freshly created, an override, or a parent/legacy
   * container). Returns an unsubscribe function. A listener that throws is
   * caught and ignored.
   */
  ${resolveListenerOverload()}
    ${own}this.resolveListeners.add(listener);
    return () => { this.resolveListeners.delete(listener); };
  }

  private notifyResolve(token: unknown, instance: unknown): void {
    for (const listener of this.resolveListeners) {
      try {
        listener(token, instance);
      } catch {
        // A listener's own bug must never break the resolution it's observing.
      }
    }
  }`;
}

/**
 * The override table and the resolve listeners of a box. In open mode a box that has no test overrides and no listener
 * holds no table of its own: it points at an empty one shared by the class. Nothing writes the shared tables:
 * `on()` replaces the listener set before it adds, and `override()` is refused when test overrides are off.
 */
function tableFieldsOf(className: string, single: boolean, testOverrides: boolean): string {
  const listeners = 'Set<(token: unknown, instance: unknown) => void>';
  const overrides = 'Map<unknown, () => unknown>';
  if (!single) return `\n  private overrides = new ${overrides}();\n  private resolveListeners = new ${listeners}();`;
  const sharedOverrides = testOverrides ? '' : `\n  private static readonly __neoNoOverrides = new ${overrides}();`;
  const own = testOverrides ? `new ${overrides}()` : `${className}.__neoNoOverrides`;
  return `\n  private static readonly __neoNoListeners = new ${listeners}();${sharedOverrides}
  private overrides: ${overrides} = ${own};
  private resolveListeners: ${listeners} = ${className}.__neoNoListeners;`;
}

function formatTokenMember(): string {
  return `private static formatToken(token: unknown): string {
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
            } catch (e) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${input.notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${input.className}.formatToken(token)}\`);`;
}

/**
 * One row per retained provider: its token, and the accessor that answers it. A pruned provider has no row, no
 * accessor, no key. Two providers never share a token: the analyzer refuses a duplicate registration.
 */
function dispatchEntries(input: OptimizedContainerInput, ids: Iterable<TokenId>): DispatchEntry[] {
  const entries: DispatchEntry[] = [];
  for (const tokenId of ids) {
    const node = input.graph.nodes.get(tokenId);
    if (!node || node.service.type === 'parent') continue;
    entries.push({
      keyExpression: resolveTokenKey(node.service, input.getImport),
      accessor: input.minimal ? getDirectName(tokenId) : getReadName(tokenId),
    });
  }
  return entries;
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

/**
 * The guards come before the table read: state, parents, the refused multi token, the override that wins over a
 * cached instance. A table miss falls through to the parent containers and to the not-found error.
 */
function resolveInterior(input: OptimizedContainerInput, read: string, multiGuard: string): string {
  return `${parentOpenCheck(input.hasAsync, input.minimal)}
    ${multiGuard}
    ${overrideBlock(input)}
    ${read}
    ${legacyAndNotFound(input)}`;
}

/**
 * A table is declared only when a row can be served from it, and only when it has more than `dispatchLinearMax` rows:
 * a smaller one is the linear cases, read in place and declared nowhere.
 */
function tableRead(input: OptimizedContainerInput, field: string, entries: readonly DispatchEntry[]): string {
  if (entries.length === 0) return '';
  return dispatchIsLinear(entries, input.dispatchLinearMax) ? emitLinearRead(entries, 'single') : emitDispatchRead(input.className, field);
}

function tableField(input: OptimizedContainerInput, field: string, entries: readonly DispatchEntry[]): string {
  if (entries.length === 0 || dispatchIsLinear(entries, input.dispatchLinearMax)) return '';
  return emitDispatchField(input.className, field, entries);
}

/**
 * Public resolve plus the internal dispatcher.
 * Open: `_resolveInternal` reads `__neoDispatch`, one row per local provider.
 * Closed: `resolve` reads `__neoRoots`, one row per exported root, and never reaches the generic dispatcher.
 * The dispatcher has rows for the local providers only when an opaque factory may ask for any token;
 * otherwise it serves parent tokens alone, a declared local dependency has its own accessor.
 * `internalTable` is declared with `_resolveInternal`, `rootsTable` with the closed `resolve`.
 */
function resolveMethods(
  input: OptimizedContainerInput,
  listLocals: boolean,
): { publicMethod: Fragment; internalMethod: string; internalTable: string; rootsTable: string } {
  const guard = input.hasAsync ? 'this._guardPublic();\n    ' : '';
  const multiGuard = generateMultiResolveGuard(input.graph, input.getImport, input.hasAsync);
  const local = dispatchEntries(input, listLocals ? input.sorted : []);
  const internalMethod = `${singleOverload('private', '_resolveInternal')}
    ${resolveInterior(input, tableRead(input, '__neoDispatch', local), multiGuard)}
  }`;
  const internalTable = tableField(input, '__neoDispatch', local);
  if (!input.closed) {
    // The open public method calls the dispatcher, so it asks for it.
    return {
      publicMethod: withNeeds(fragment`${singleOverload('public', 'resolve')}
    ${guard}return this._resolveInternal(token);
  }`, ['resolveSingle']),
      internalMethod,
      internalTable,
      rootsTable: '',
    };
  }
  const roots = dispatchEntries(input, input.graph.publicRoots ?? []);
  return {
    publicMethod: fragment`${singleOverload('public', 'resolve')}
    ${guard}this._assertRoot(token, false);
    ${resolveInterior(input, tableRead(input, '__neoRoots', roots), '')}
  }`,
    internalMethod,
    internalTable,
    rootsTable: tableField(input, '__neoRoots', roots),
  };
}

function joined(members: readonly string[]): string {
  return members.filter((member) => member !== '').join('\n\n  ');
}

/**
 * The readers of the multi tokens, and the two tables over them: `__neoRootLists` over the exported roots
 * (closed), `__neoLists` over the internal tokens when `_resolveAllInternal` is emitted. A token that is both
 * has one reader and a row in each table. Each table is decided on its own rows; a reader is a member only for a table
 * that is read from the `Map`, a linear table has the body inline.
 */
function listMembers(
  input: OptimizedContainerInput,
  publicLists: readonly ListReader[],
  internalLists: readonly ListReader[],
): string[] {
  const rows = (lists: readonly ListReader[]): DispatchEntry[] => lists.map((reader) => reader.entry);
  const isTable = (lists: readonly ListReader[]): boolean =>
    lists.length > 0 && !dispatchIsLinear(rows(lists), input.dispatchLinearMax);
  const rootsAsTable = isTable(publicLists);
  const internalAsTable = isTable(internalLists);
  const readers = new Map<TokenId, ListReader>();
  for (const reader of [...(internalAsTable ? internalLists : []), ...(rootsAsTable ? publicLists : [])]) {
    if (!readers.has(reader.tokenId)) readers.set(reader.tokenId, reader);
  }
  return [
    ...[...readers.values()].map((reader) => reader.method),
    ...(rootsAsTable ? [emitDispatchField(input.className, '__neoRootLists', rows(publicLists), 'list')] : []),
    ...(internalAsTable ? [emitDispatchField(input.className, '__neoLists', rows(internalLists), 'list')] : []),
  ];
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
export function emitOptimizedContainer(input: OptimizedContainerInput): Fragment {
  const { graph, sorted, getImport, getForeignImport, hasAsync, closed, minimal } = input;
  const copy = input.copy ?? generatedCopy;
  const parentName = input.legacyParentName ?? 'NeoLegacyParent';
  const providerTypes = input.providerTypes ?? noProviderTypes;
  const direct: DirectReads = { notify: !minimal };
  const honourOverrides = !minimal && input.testOverrides;
  // Full profile, open mode: one `_get_` accessor per registration. A sync class provider has no other reader, so its
  // accessor builds it in place and its creator is not emitted. Closed mode keeps its creators (an eager root calls
  // one) and its `_direct_` accessors; the minimal profile has no `_get_`.
  const unified = !minimal && !closed;
  const inlined = new Map<TokenId, string>();
  if (unified) {
    for (const tokenId of sorted) {
      const node = graph.nodes.get(tokenId);
      // Only a class registration has an implementation symbol (packages/core/src/analyzer/graphAdapter.ts:374-419).
      const symbol = node?.service.implementationSymbol;
      if (!node || !symbol) continue;
      inlined.set(tokenId, constructionExpression(node, symbol, graph, getImport, getForeignImport, hasAsync, closed, direct, providerTypes));
    }
  }
  const creators = [
    ...generateFactories(graph, sorted, getImport, getForeignImport, hasAsync, closed, direct, copy, providerTypes, input.className, new Set(inlined.keys())),
    ...generateMultiFactories(graph, getImport, getForeignImport, hasAsync, closed, direct, copy, providerTypes, input.className),
  ];
  const accessors = [
    ...generateDirectAccessors(graph, sorted, getImport, hasAsync, { minimal, honourOverrides, single: unified }, `${input.className}.formatToken`, providerTypes, inlined),
    ...generateDirectContributions(graph, hasAsync, providerTypes),
  ];
  const needs = factoryContextNeeds(graph);
  const listLocals = !closed || needs.opaque;
  const resolve = resolveMethods(input, listLocals);
  const resolveAll = generateDirectResolveAll(
    graph,
    getImport,
    hasAsync,
    closed,
    minimal,
    input.className,
    input.dispatchLinearMax,
    listLocals ? undefined : needs.multiAll,
  );
  const resolveAllPublic = withNeeds(fragment`${resolveAll.publicMethod}`, closed ? [] : ['resolveAll']);

  // Each generic resolver is declared only when a fragment asks for it. Open: the public methods
  // call it. Closed: only a factory that reads a parent token, a declared multi token or any token
  // (opaque) does. The emitters declare that; no text, user text included, is searched.
  const catalog: Helper[] = [
    { id: 'resolveSingle', parts: [generatedText(joined([resolve.internalMethod, resolve.internalTable]))], needs: [] },
    { id: 'resolveAll', parts: [generatedText(resolveAll.internalMethod)], needs: [] },
    ...factoryLeaseHelpers(input.className),
  ];
  // Deviation from the spec's `linkHelpers`: the helpers are kept in their slots (after `resolve`,
  // after `resolveAll`) and not put before every root, because moving them would change the
  // emitted class. `selectHelpers` is the first half of `linkHelpers`: same catalog, same needs.
  const linked = new Map(
    selectHelpers([...creators, resolve.publicMethod, resolveAllPublic], catalog).map((helper) => [helper.id, helper]),
  );

  const initialize = hasAsync
    ? generateInitializeMethod(graph, sorted, getImport, hasAsync, input.eagerLines, minimal)
    : input.eagerLines.length > 0
      ? generateEagerSyncInitialize(input.eagerLines, minimal)
      : generateSyncInitializeMethod(minimal);
  const destroy = generateDestroyMethod(graph, sorted, getImport, hasAsync, minimal);
  const tableFields = minimal ? '' : tableFieldsOf(input.className, unified, input.testOverrides);
  const members: Piece[] = [
    input.runtimeHelpers + input.assertRootMethod,
    initialize,
    generateCreateScopeMethod(input.className, hasAsync, minimal),
  ];
  // The policy and the lease of the declared factories: only the helpers a creator asks for.
  for (const id of ['factoryPolicy', 'factoryLease'] as const) {
    const factoryHelper = linked.get(id);
    if (factoryHelper) members.push(factoryHelper);
  }
  if (!minimal) {
    members.push(generateOverrideMethods(graph, sorted, getImport, hasAsync, input.testOverrides));
    members.push(eventMembers(input.className, unified));
  }
  if (honourOverrides) members.push(mockMethod());
  members.push(resolve.publicMethod);
  if (resolve.rootsTable !== '') members.push(resolve.rootsTable);
  const single = linked.get('resolveSingle');
  if (single) members.push(single);
  members.push(formatTokenMember(), destroy, resolveAllPublic);
  const many = linked.get('resolveAll');
  if (many) members.push(many);
  members.push(...listMembers(input, resolveAll.publicLists, many ? resolveAll.internalLists : []));
  members.push(input.debugGetters);

  const container = fragment`${legacyParentInterface(parentName)}

class ${input.notFoundErrorClassName} extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class ${input.className} {
  private instances = new Map<unknown, unknown>();${tableFields}
  ${input.stateFields}${input.rootFields}

  // -- Factories --
  ${concat(creators, '\n  ')}

  // -- Accessors --
  ${accessors.join('\n  ')}

  constructor(
    private legacy?: ${parentName}[],
    private name: string = 'NeoContainer'
  ) {}

  ${concat(members, '\n\n  ')}
}`;
  // Every need is met by a helper above: what leaves here asks for nothing.
  return { parts: container.parts, needs: [] };
}
