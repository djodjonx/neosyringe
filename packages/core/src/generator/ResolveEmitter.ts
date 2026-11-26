import type { DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../analyzer/types';
import { getDirectName, getFactoryName, getReadName, multiRegistrationKey, parentTokenKey, resolveTokenKey, type GetImport } from './FactoryEmitter';
import { dispatchIsLinear, emitDispatchRead, emitLinearRead, type DispatchEntry } from './dispatchEmitter';
import { boundGuard } from './inputEmitter';
import { noProviderTypes, type GetProviderTypes } from './providerTypes';
import { aliasPlanOf } from '../analyzer/shared/aliasLinks';
import { getSimpleName } from '../analyzer/utils/TokenUtils';

/**
 * `name<T>(token): T` as an overload over an `unknown` implementation. The body hands out `unknown`
 * values, and the caller picks the type it expects: the overload states that contract, the
 * implementation never asserts it (TYPES-SAFETY.md, "Méthodes générées").
 */
export function singleOverload(access: 'public' | 'private', name: string): string {
  return `${access} ${name}<T>(token: unknown): T;
  ${access} ${name}(token: unknown): unknown {`;
}

/** Same as {@link singleOverload}, for the methods that answer a list. */
export function listOverload(access: 'public' | 'private', name: string): string {
  return `${access} ${name}<T>(token: unknown): T[];
  ${access} ${name}(token: unknown): unknown[] {`;
}

/**
 * `on('resolve', listener)` as an overload over an `unknown` implementation. The container stores and calls
 * every listener with a token of any kind, so the implementation takes `unknown`. A consumer types its listener
 * with the public shape (`(token: Token<unknown>, instance: unknown) => void`, packages/neosyringe/src/types.ts),
 * and on the transformer path the exported container is typed by this class, so a listener with an `unknown`
 * token only would force a consumer cast. The overload is generic in the token (`K`) instead: tsc erases a type
 * parameter when it compares an overload with its implementation, so the pair is accepted without `any`, and a
 * call infers `K` from the consumer's listener. `Token` itself is not declared in the generated file.
 */
export function resolveListenerOverload(): string {
  return `public on<K>(event: 'resolve', listener: (token: K, instance: unknown) => void): () => void;
  public on(event: 'resolve', listener: (token: unknown, instance: unknown) => void): () => void {`;
}

/**
 * The part of a `useContainer` parent the generated container reads: a NeoSyringe container or an adapter
 * from `declareContainerTokens`. Every member is optional because an adapter may answer none of them.
 * The closed flag and the name are read through one local assertion in `_assertParents`: on a container
 * they are private, so they cannot be part of a shape a container is assigned to.
 */
export function legacyParentInterface(name: string): string {
  return `interface ${name} {
  resolve?(token: unknown): unknown;
  resolveAll?(token: unknown): unknown;
  initialize?(): unknown;
}`;
}

/** useValue and an explicit borrowed factory stay out of the disposal journal. A value is never owned. */
export function isBorrowedInstance(service: ServiceDefinition): boolean {
  return service.ownership === 'borrowed' || service.type === 'value';
}

/** Cache a singleton. The journal keeps the token key, not the instance (T07-B07). */
export function afterStore(valueExpr: string, tokenKey: string, hasAsync: boolean, borrowed: boolean): string {
  const mark = borrowed ? ` this._borrowed.add(${valueExpr});` : '';
  const journal = hasAsync ? ` if (this._initRunning) this._initJournal.push(${tokenKey});` : '';
  return `this.instances.set(${tokenKey}, ${valueExpr});${mark}${journal}`;
}

export function parentOpenCheck(hasAsync: boolean, minimal = false): string {
  const syncGate = hasAsync
    ? ''
    : `${minimal ? '' : "if (this._reconfiguring) throw this._neoFail('NEO_CONTAINER_BUSY', 'container is transitioning');\n    "}if (this._failure !== undefined) throw this._neoFail('NEO_CONTAINER_FAILED', 'container initialization failed', this._failure);
    `;
  const self = hasAsync
    ? `if (!this._initRunning && this._touchClosed(false)) throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');`
    : `if (this._touchClosed(false)) throw this._neoFail('NEO_CONTAINER_DESTROYED', 'container is destroyed');`;
  return `${syncGate}${self}
    this._assertParents();`;
}

/**
 * The guard `resolveMany` runs before it reads its list, whatever the list holds: the checks `resolve` makes, so an
 * empty batch is refused as a batch of one token is. A sync container has the same open check as the interior of
 * `resolve` ({@link parentOpenCheck}). An async one checks its initialization state first, as its public `resolve`
 * does with `_guardPublic`, then the parents.
 */
export function manyEntryGuard(hasAsync: boolean, minimal: boolean): string {
  if (!hasAsync) return parentOpenCheck(false, minimal);
  return `this._guardPublic('resolveMany()');
    this._assertParents();`;
}

/**
 * The refusals of a token that `override` and `overrideMany` share, one text per rule: the same token keys as
 * {@link generateMultiResolveGuard}. Checked before any state change. `override` answers a rejected promise (`reject`),
 * the batch loop throws (`throw`): its try block turns a throw into the rejection, so no `return` leaves the loop.
 */
export function overrideTokenChecks(graph: DependencyGraph, getImport: GetImport, form: 'reject' | 'throw'): string {
  const refuse = (failure: string): string => (form === 'reject' ? `return Promise.reject(${failure})` : `throw ${failure}`);
  const checks: string[] = [];
  for (const nodes of graph.multiNodes?.values() ?? []) {
    const tokenKey = resolveTokenKey(nodes[0].service, getImport);
    checks.push(`if (token === ${tokenKey}) ${refuse(`this._neoFail('NEO_OVERRIDE_MULTI_UNSUPPORTED', 'cannot override a multi token')`)};`);
  }
  // An alias answers what its target answers and keeps nothing: the override is the target's. The message names the
  // end of the chain, the registration a test replaces.
  const plan = aliasPlanOf(graph);
  if (plan !== undefined) {
    for (const [tokenId, node] of graph.nodes) {
      if (!plan.isAlias(tokenId)) continue;
      const message = JSON.stringify(`cannot override an alias: override its target '${getSimpleName(plan.canonicalOf(tokenId))}'`);
      checks.push(`if (token === ${resolveTokenKey(node.service, getImport)}) ${refuse(`this._neoFail('NEO_OVERRIDE_ALIAS_UNSUPPORTED', ${message})`)};`);
    }
  }
  return checks.join(form === 'reject' ? '\n    ' : '\n        ');
}

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
    if (node.service.type === 'parent' || node.service.type === 'alias') continue;

    const factoryId = getFactoryName(tokenId);
    const isTransient = node.service.lifecycle === 'transient';
    const tokenKey = resolveTokenKey(node.service, getImport);
    const tokenCheck = `if (token === ${tokenKey})`;
    const asyncSingleton = hasAsync && !!node.service.isAsync && !isTransient;
    const borrowed = isBorrowedInstance(node.service);
    const stored = afterStore('instance', tokenKey, hasAsync, borrowed);

    const creationLogic = isTransient
      ? `return this.${factoryId}();`
      : asyncSingleton
        ? `
            if (!this.instances.has(${tokenKey})) {
                throw new Error('async singleton is not prepared: ' + ${formatToken}(token));
            }
            return this.instances.get(${tokenKey});
          `
        : `
            if (!this.instances.has(${tokenKey})) {
                const instance = this.${factoryId}();
                ${stored}
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
  const stored = afterStore('inst', 'k', hasAsync, isBorrowedInstance(node.service));
  return `(() => { const k = ${key}; if (!this.instances.has(k)) { const inst = this.${factoryId}(); ${stored} } return this.instances.get(k); })()`;
}

function orderedContributions(nodes: DependencyNode[]): DependencyNode[] {
  return nodes.slice();
}

function freshList(expr: string): string {
  return `{ const __neoAll = [${expr}]; for (const __neoNoted of __neoAll) this.notifyResolve(token, __neoNoted); return __neoAll.slice(); }`;
}

function legacyResolveAll(notify = true): string {
  const noted = notify ? ' for (const __neoItem of __neoListed) this.notifyResolve(token, __neoItem);' : '';
  return `if (this.legacy) {
      for (const __neoLegacy of this.legacy) {
        if (typeof __neoLegacy?.resolveAll === 'function') {
          const __neoListed = __neoLegacy.resolveAll(token);
          if (Array.isArray(__neoListed)) { for (const __neoItem of __neoListed) { if (__neoItem != null) this._borrowed.add(__neoItem); }${noted} return __neoListed.slice(); }
        }
      }
    }
    return [];`;
}

/** Generates the resolveAll() method with one branch per multi-token. */
export function generateResolveAllMethod(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
  closed = false,
): string {
  const tail = legacyResolveAll();
  const open = parentOpenCheck(hasAsync);
  const bound = boundGuard(graph, 'resolveAll()');
  if (closed) return closedResolveAll(graph, getImport, hasAsync, open, tail);
  if (!graph.multiNodes || graph.multiNodes.size === 0) {
    if (!hasAsync) {
      return `${listOverload('public', 'resolveAll')}
    ${bound}${open}
    ${tail}
  }`;
    }
    return `${listOverload('public', 'resolveAll')}
    ${bound}this._guardPublic('resolveAll()');
    return this._resolveAllInternal(token);
  }

  ${listOverload('private', '_resolveAllInternal')}
    ${open}
    ${tail}
  }`;
  }

  const cases: string[] = [];

  for (const [tokenId, nodes] of graph.multiNodes) {
    const contributions = orderedContributions(nodes);
    const tokenKey = resolveTokenKey(contributions[0].service, getImport);
    const tokenCheck = `if (token === ${tokenKey})`;
    const factoryBase = getFactoryName(tokenId);
    const callExprs = contributions.map((node, index) => contributionCall(node, tokenId, index, factoryBase, hasAsync));
    cases.push(`${tokenCheck} ${freshList(callExprs.join(', '))}`);
  }

  if (!hasAsync) {
    return `${listOverload('public', 'resolveAll')}
    ${bound}${open}
    ${cases.join('\n    ')}
    ${tail}
  }`;
  }

  return `${listOverload('public', 'resolveAll')}
    ${bound}this._guardPublic('resolveAll()');
    return this._resolveAllInternal(token);
  }

  ${listOverload('private', '_resolveAllInternal')}
    ${open}
    ${cases.join('\n    ')}
    ${tail}
  }`;
}

/** Public resolveAll checks the exported multi roots, then the internal list. ADR006 lines 29-33. */
function closedResolveAll(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
  open: string,
  tail: string,
): string {
  const cases: string[] = [];
  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      const contributions = orderedContributions(nodes);
      const tokenKey = resolveTokenKey(contributions[0].service, getImport);
      const factoryBase = getFactoryName(tokenId);
      const callExprs = contributions.map((node, index) => contributionCall(node, tokenId, index, factoryBase, hasAsync));
      cases.push(`if (token === ${tokenKey}) ${freshList(callExprs.join(', '))}`);
    }
  }
  const body = cases.length === 0 ? `${open}\n    ${tail}` : `${open}\n    ${cases.join('\n    ')}\n    ${tail}`;
  const guard = `${boundGuard(graph, 'resolveAll()')}${hasAsync ? `this._guardPublic('resolveAll()');\n    ` : ''}`;
  return `${listOverload('public', 'resolveAll')}
    ${guard}this._assertRoot(token, true);
    return this._resolveAllInternal(token);
  }

  ${listOverload('private', '_resolveAllInternal')}
    ${body}
  }`;
}

/** What the optimized accessors need to know about the profile. */
export interface DirectProfile {
  /** Minimal drops the resolve event and the overrides table. */
  minimal: boolean;
  /** Full profile with test overrides: an internal read must honour a mock too. */
  honourOverrides: boolean;
  /** Full profile, open mode: one `_get_` accessor per registration, with no `_direct_` twin. */
  single: boolean;
}

interface SingleAccessor {
  name: string;
  returns: string;
  tokenKey: string;
  /** The expression that builds the value, asserted to the accessor's type. */
  created: string;
  asType: string;
  mockType: string;
  transient: boolean;
  asyncSingleton: boolean;
  honourOverrides: boolean;
  stored: string;
  formatToken: string;
}

/**
 * The `_get_` accessor of open mode: the read of `_direct_` and the resolve event in one method. An override answers
 * through `_mock` and fires the event, a cache hit fires it, a fresh value is stored then fires it.
 */
function singleAccessor(a: SingleAccessor): string {
  const mock = a.honourOverrides
    ? `if (this.overrides.has(${a.tokenKey})) {
      const __neoMocked = this._mock${a.mockType}(${a.tokenKey});
      this.notifyResolve(${a.tokenKey}, __neoMocked);
      return __neoMocked;
    }
    `
    : '';
  const read = a.transient
    ? `const __neoValue: ${a.returns} = ${a.created};`
    : a.asyncSingleton
      ? `if (!this.instances.has(${a.tokenKey})) throw new Error('async singleton is not prepared: ' + ${a.formatToken}(${a.tokenKey}));
    const __neoValue: ${a.returns} = this.instances.get(${a.tokenKey})${a.asType};`
      : `let __neoValue: ${a.returns};
    if (this.instances.has(${a.tokenKey})) __neoValue = this.instances.get(${a.tokenKey})${a.asType};
    else {
      __neoValue = ${a.created};
      ${a.stored}
    }`;
  return `
  private ${a.name}(): ${a.returns} {
    ${mock}${read}
    this.notifyResolve(${a.tokenKey}, __neoValue);
    return __neoValue;
  }`;
}

/**
 * One accessor per registration, reading its own container state.
 * The cache flag is the presence of the key in `instances`, never the value, so a
 * factory that returns undefined or null runs once. Full profile adds a `_get_` twin
 * that fires the resolve event on every read, cache hit included. In open mode the twin is the only accessor:
 * `_get_` reads, creates and fires the event itself, and a class provider in `inlined` is built in its body
 * (the text is the `new Class(args)` of its creator, which is then not emitted).
 *
 * An accessor answers the type of its provider (`providerTypes`), `unknown` where the output cannot name it.
 * Its body is checked against that type. Three reads need one `as <type>` each, and only those:
 * - a cache hit: `instances` is a `Map<unknown, unknown>`, and the only writers of a key are this accessor
 *   (it stores what its own creator returned) and `_mock` (an override: a test double stands for the type);
 * - the creator of a factory, which answers `unknown` (a user's factory text, a promise for an async one);
 * - an override read through `_mock`, which is generic over its answer (an overload over an `unknown` body).
 * Class providers and hoisted values need none for the value they build: their creator has the type.
 * Test: packages/core/tests/generator/t23-getter-types.test.ts.
 */
export function generateDirectAccessors(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  hasAsync: boolean,
  profile: DirectProfile,
  formatToken: string,
  providerTypes: GetProviderTypes = noProviderTypes,
  inlined: ReadonlyMap<TokenId, string> = new Map(),
  aliasReads: ReadonlyMap<TokenId, string> = new Map(),
): string[] {
  const accessors: string[] = [];
  const plan = aliasPlanOf(graph);
  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node || node.service.type === 'parent') continue;
    const factoryId = getFactoryName(tokenId);
    const tokenKey = resolveTokenKey(node.service, getImport);
    // An alias has no state, no creator and no disposal: its accessor reads the target and, in the full profile, fires
    // the event of the alias token. The target is read through its `_direct_` accessor, which fires none.
    const aliased = aliasReads.get(tokenId);
    if (node.service.type === 'alias' && aliased !== undefined) {
      const returns = providerTypes(node).accessor ?? 'unknown';
      if (profile.single) {
        accessors.push(singleAccessor({
          name: getReadName(tokenId), returns, tokenKey, created: aliased, asType: '', mockType: '',
          transient: true, asyncSingleton: false, honourOverrides: false, stored: '', formatToken,
        }));
        continue;
      }
      accessors.push(`
  private ${getDirectName(tokenId)}(): ${returns} {
    return ${aliased};
  }`);
      if (!profile.minimal) {
        accessors.push(`
  private ${getReadName(tokenId)}(): ${returns} {
    const __neoValue = this.${getDirectName(tokenId)}();
    this.notifyResolve(${tokenKey}, __neoValue);
    return __neoValue;
  }`);
      }
      continue;
    }
    // The target of an alias keeps the two accessors an alias reads: `_direct_` (no event) and `_get_` (the event).
    const single = profile.single && !(plan?.localTargets.has(tokenId) ?? false);
    const transient = node.service.lifecycle === 'transient';
    const asyncSingleton = hasAsync && !!node.service.isAsync && !transient;
    const stored = afterStore('instance', tokenKey, hasAsync, isBorrowedInstance(node.service));
    const types = providerTypes(node);
    const returns = types.accessor ?? 'unknown';
    // `unknown` needs no assertion. A typed accessor asserts a cache read, and a creator that answers another type.
    const asType = types.accessor === undefined ? '' : ` as ${types.accessor}`;
    const asCreated = types.creator === types.accessor ? '' : asType;
    const mockType = types.accessor === undefined ? '' : `<${types.accessor}>`;
    if (single) {
      const created = inlined.get(tokenId) ?? `this.${factoryId}()`;
      accessors.push(singleAccessor({
        name: getReadName(tokenId), returns, tokenKey, created: `${created}${asCreated}`, asType, mockType,
        transient, asyncSingleton, honourOverrides: profile.honourOverrides,
        stored: afterStore('__neoValue', tokenKey, hasAsync, isBorrowedInstance(node.service)), formatToken,
      }));
      continue;
    }
    const mock = profile.honourOverrides ? `if (this.overrides.has(${tokenKey})) return this._mock${mockType}(${tokenKey});\n    ` : '';
    const body = transient
      ? `return this.${factoryId}()${asCreated};`
      : asyncSingleton
        ? `if (!this.instances.has(${tokenKey})) throw new Error('async singleton is not prepared: ' + ${formatToken}(${tokenKey}));
    return this.instances.get(${tokenKey})${asType};`
        : `if (this.instances.has(${tokenKey})) return this.instances.get(${tokenKey})${asType};
    const instance = this.${factoryId}()${asCreated};
    ${stored}
    return instance;`;
    accessors.push(`
  private ${getDirectName(tokenId)}(): ${returns} {
    ${mock}${body}
  }`);
    if (profile.minimal) continue;
    accessors.push(`
  private ${getReadName(tokenId)}(): ${returns} {
    const __neoValue = this.${getDirectName(tokenId)}();
    this.notifyResolve(${tokenKey}, __neoValue);
    return __neoValue;
  }`);
  }
  return accessors;
}

/**
 * Indexed accessors for multi contributions. The cache key is the same as {@link contributionCall}.
 * An accessor answers the type of its provider where the output can name it (`providerTypes`), like the single
 * accessors: a cache hit and the creator of a factory (which answers `unknown`) carry the one `as <type>` they need,
 * a class provider and a hoisted value need none. `unknown` where the output has no name for the type.
 */
export function generateDirectContributions(
  graph: DependencyGraph,
  hasAsync: boolean,
  providerTypes: GetProviderTypes = noProviderTypes,
): string[] {
  const accessors: string[] = [];
  if (!graph.multiNodes) return accessors;
  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${getFactoryName(tokenId)}_${index}`;
      const key = multiRegistrationKey(node, tokenId, index);
      const types = providerTypes(node);
      const returns = types.accessor ?? 'unknown';
      const asType = types.accessor === undefined ? '' : ` as ${types.accessor}`;
      const asCreated = types.creator === types.accessor ? '' : asType;
      if (node.service.lifecycle === 'transient') {
        accessors.push(`
  private ${getDirectName(tokenId, index)}(): ${returns} {
    return this.${factoryId}()${asCreated};
  }`);
        return;
      }
      if (hasAsync && node.service.isAsync) {
        accessors.push(`
  private ${getDirectName(tokenId, index)}(): ${returns} {
    return this.instances.get(${key})${asType};
  }`);
        return;
      }
      const stored = afterStore('inst', 'k', hasAsync, isBorrowedInstance(node.service));
      accessors.push(`
  private ${getDirectName(tokenId, index)}(): ${returns} {
    const k = ${key};
    if (this.instances.has(k)) return this.instances.get(k)${asType};
    const inst = this.${factoryId}()${asCreated};
    ${stored}
    return inst;
  }`);
    });
  }
  return accessors;
}

function directList(graph: DependencyGraph, tokenId: TokenId, minimal: boolean): string {
  const nodes = graph.multiNodes?.get(tokenId) ?? [];
  const calls = nodes.map((_, index) => `this.${getDirectName(tokenId, index)}()`).join(', ');
  if (minimal) return `return [${calls}];`;
  return `{ const __neoAll = [${calls}]; for (const __neoNoted of __neoAll) this.notifyResolve(token, __neoNoted); return __neoAll.slice(); }`;
}

/** `_list_<id>`: the reader of one multi token, named like {@link getDirectName} and {@link getReadName}. */
function getListName(tokenId: TokenId): string {
  return getDirectName(tokenId).replace(/^_direct_/, '_list_');
}

/** One multi token as the shared `__neoLists` table serves it: its key, and the member that answers its contributions. */
export interface ListReader {
  tokenId: TokenId;
  entry: DispatchEntry;
  /** The member, as class text. The full profile notifies the resolve event with the asked token, so it takes it. */
  method: string;
  /** What the member does, as the body of a linear case. */
  inline: string;
}

function listReader(
  graph: DependencyGraph,
  getImport: GetImport,
  tokenId: TokenId,
  minimal: boolean,
): ListReader | undefined {
  const nodes = graph.multiNodes?.get(tokenId);
  if (!nodes || nodes.length === 0) return undefined;
  const name = getListName(tokenId);
  const param = minimal ? '' : 'token: unknown';
  const inline = directList(graph, tokenId, minimal);
  return {
    tokenId,
    entry: { keyExpression: resolveTokenKey(nodes[0].service, getImport), accessor: name },
    method: `private ${name}(${param}): unknown[] {
    ${inline}
  }`,
    inline,
  };
}

/**
 * resolveAll for the optimized emitter. Same shape in sync and async containers:
 * `resolveAll` checks the entry, `_resolveAllInternal` lists every local multi token.
 * Closed: the public method lists the exported multi roots only, and the internal
 * one lists `internalIds` (the multi tokens a factory context still reads), not every token.
 *
 * Both methods read a table of the class (dispatchEmitter.ts), one reader per multi token: `_resolveAllInternal`
 * reads `__neoLists`, the closed public method reads `__neoRootLists`, which holds the exported roots and nothing
 * else. The caller declares each table over the readers it keeps: `publicLists` for `__neoRootLists`, and
 * `internalLists` for `__neoLists` when it emits `_resolveAllInternal`. A table of at most `linearMax` readers is read
 * as linear cases, the body of each reader inline, and the caller declares no table for it.
 */
export function generateDirectResolveAll(
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
  closed: boolean,
  minimal: boolean,
  className: string,
  linearMax: number,
  internalIds: Iterable<TokenId> = graph.multiNodes?.keys() ?? [],
): { publicMethod: string; internalMethod: string; publicLists: ListReader[]; internalLists: ListReader[] } {
  const tail = legacyResolveAll(!minimal);
  const open = parentOpenCheck(hasAsync, minimal);
  const guard = `${boundGuard(graph, 'resolveAll()')}${hasAsync ? `this._guardPublic('resolveAll()');\n    ` : ''}`;
  const readersFor = (ids: Iterable<TokenId>): ListReader[] => {
    const readers: ListReader[] = [];
    for (const tokenId of ids) {
      const reader = listReader(graph, getImport, tokenId, minimal);
      if (reader) readers.push(reader);
    }
    return readers;
  };
  const readFor = (readers: readonly ListReader[], field: string): string => {
    if (readers.length === 0) return '';
    const entries = readers.map((reader) => ({ ...reader.entry, inline: reader.inline }));
    return dispatchIsLinear(entries, linearMax) ? emitLinearRead(entries, 'list') : emitDispatchRead(className, field, 'list');
  };
  const internalLists = readersFor(internalIds);
  const internalMethod = `${listOverload('private', '_resolveAllInternal')}
    ${open}
    ${readFor(internalLists, '__neoLists')}
    ${tail}
  }`;
  if (!closed) {
    return {
      publicMethod: `${listOverload('public', 'resolveAll')}
    ${guard}return this._resolveAllInternal(token);
  }`,
      internalMethod,
      publicLists: [],
      internalLists,
    };
  }
  const publicLists = readersFor(graph.publicMultiRoots ?? []);
  return {
    publicMethod: `${listOverload('public', 'resolveAll')}
    ${guard}this._assertRoot(token, true);
    ${open}
    ${readFor(publicLists, '__neoRootLists')}
    ${tail}
  }`,
    internalMethod,
    publicLists,
    internalLists,
  };
}

/**
 * `_neoParent(token)`: the read of a token a `useContainer` parent provides, for an alias whose target the parent owns.
 * It is the delegation loop of the generic resolver without its resolve event: the event of the read is the alias
 * token's, the caller fires it. The parent answers a token it does not know with `NeoServiceNotFoundError`, which is
 * the one error the loop skips.
 */
export function parentReadMethod(notFoundErrorClassName: string, className: string): string {
  return `private _neoParent(token: unknown): unknown {
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) {
                    const legacyResult = legacyContainer.resolve(token);
                    if (legacyResult != null) this._borrowed.add(legacyResult);
                    return legacyResult;
                }
            } catch (e) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${className}.formatToken(token)}\`);
  }`;
}

/** True when an alias of the graph ends at a token a parent provides: the class then needs `_neoParent`. */
export function readsParentForAlias(graph: DependencyGraph): boolean {
  const plan = aliasPlanOf(graph);
  if (plan === undefined) return false;
  for (const tokenId of graph.nodes.keys()) {
    if (plan.isAlias(tokenId) && !plan.isLocal(tokenId)) return true;
  }
  return false;
}

/**
 * Reference emitter. One table from each alias to its canonical target, and one reader of the canonical targets that
 * honours an override of the target first, whether the target is local or a parent's (an alias is never overridden itself). The generic resolver looks a token up
 * in the table before it reads its own cases, so a chain of any length is one lookup.
 */
export function generateAliasMembers(
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  className: string,
  notFoundErrorClassName: string,
): { members: string; step: string } | undefined {
  const plan = aliasPlanOf(graph);
  if (plan === undefined) return undefined;
  const rows: string[] = [];
  const reads: string[] = [];
  const read = new Set<TokenId>();
  for (const [tokenId, node] of graph.nodes) {
    if (!plan.isAlias(tokenId)) continue;
    const target = plan.canonicalOf(tokenId);
    const targetNode = graph.nodes.get(target);
    const local = plan.isLocal(tokenId);
    const targetKey = local && targetNode ? resolveTokenKey(targetNode.service, getImport) : parentTokenKey(graph, target, getForeignImport);
    rows.push(`[${resolveTokenKey(node.service, getImport)}, ${targetKey}]`);
    if (!local || read.has(target)) continue;
    read.add(target);
    reads.push(`if (target === ${targetKey}) return this.resolveLocal(${targetKey});`);
  }
  const parent = readsParentForAlias(graph);
  const members = `private static readonly __neoAliases = new Map<unknown, unknown>([
    ${rows.join(',\n    ')}
  ]);

  private _neoAliasRead(target: unknown): unknown {
    if (this.overrides.has(target)) {
      if (!this.instances.has(target)) {
        const __neoMock = this.overrides.get(target)!();
        this.instances.set(target, __neoMock);
        if (__neoMock != null) this._borrowed.add(__neoMock);
      }
      return this.instances.get(target);
    }
    ${reads.join('\n    ')}
    ${parent ? 'return this._neoParent(target);' : 'return undefined;'}
  }${parent ? `\n\n  ${parentReadMethod(notFoundErrorClassName, className)}` : ''}`;
  const step = `// 0b. An alias answers what its target answers. The event is the alias token's, never the target's.
    const __neoCanonical = ${className}.__neoAliases.get(token);
    if (__neoCanonical !== undefined) {
      const __neoAliased = this._neoAliasRead(__neoCanonical);
      this.notifyResolve(token, __neoAliased);
      return __neoAliased;
    }
`;
  return { members, step };
}
