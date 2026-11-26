import type * as ts from 'typescript';
import type { DependencyGraph, DependencyNode, FactoryDependency, TokenId } from '../analyzer/types';
import { FACTORY_NAME_SANITIZER } from '../analyzer/shared/constants';
import { getSimpleName } from '../analyzer/utils/TokenUtils';
import {
  concat,
  fragment,
  generatedCopy,
  generatedText,
  withNeeds,
  type Fragment,
  type HelperId,
  type Piece,
  type UserCopy,
} from './fragments';
import { noProviderTypes, type GetProviderTypes } from './providerTypes';
import {
  emitFactoryPolicy,
  emitFactoryRead,
  emitLeaseOpen,
  type PolicyEntry,
} from './factoryLeaseEmitter';
import { inputRead } from './inputEmitter';
import { aliasPlanOf } from '../analyzer/shared/aliasLinks';
import { DEFAULT_MANY_NAMES, factoryContextType, manyContextFunction, type ManyNames } from './manyEmitter';

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

function directRead(tokenId: TokenId, direct: DirectReads, receiver = 'this'): string {
  return direct.notify ? `${receiver}.${getReadName(tokenId)}()` : `${receiver}.${getDirectName(tokenId)}()`;
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
function resolutionCalls(hasAsync: boolean, closed = false, receiver = 'this'): { one: string; all: string; internal: boolean } {
  // Closed sync factories must not call the public resolve. ADR006 lines 29-33.
  // `internal` is the one answer to "do the calls go through the private helpers": the emitters
  // take their helper needs from it, so the text of the call and the need cannot drift apart.
  return hasAsync || closed
    ? { one: `${receiver}._resolveInternal`, all: `${receiver}._resolveAllInternal`, internal: true }
    : { one: `${receiver}.resolve`, all: `${receiver}.resolveAll`, internal: false };
}

/**
 * The constructor arguments as text, with the helpers of the generated class that text calls.
 * A caller that writes `text` into a class must declare `needs` there.
 */
export function resolveConstructorArgs(
  dependencies: TokenId[],
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync = false,
  closed = false,
  direct?: DirectReads,
  className?: string,
  providerTypes: GetProviderTypes = noProviderTypes,
): { text: string; needs: HelperId[] } {
  return constructorArguments(dependencies, graph, getImport, getForeignImport, hasAsync, closed, direct, className, providerTypes);
}

function constructorArguments(
  dependencies: TokenId[],
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync: boolean,
  closed: boolean,
  direct: DirectReads | undefined,
  className?: string,
  providerTypes: GetProviderTypes = noProviderTypes,
): { text: string; needs: HelperId[] } {
  const calls = resolutionCalls(hasAsync, closed || direct !== undefined);
  let reads = false;
  const called = (argument: string): string => {
    reads = true;
    return `${calls.one}(${argument})`;
  };
  const text = dependencies.map((depId, position) => {
    const depNode = graph.nodes.get(depId);
    if (direct && isLocalRegistration(graph, depId)) {
      const read = directRead(depId, direct);
      // The accessor has the type of its provider, so the compiler checks this argument against the parameter
      // the class declares: a provider that does not fit its token is an error in the output.
      if (depNode !== undefined && providerTypes(depNode).accessor !== undefined) return read;
      // Fallback, for a provider whose type the output cannot name (a type declared in another file and not
      // exported, an anonymous or generic type, a partial useValue read from `extends`, a hand-built graph):
      // the accessor answers `unknown`, and the argument is narrowed where the class declares its parameter.
      // That one assertion names the parameter and nothing else. It rests on an analyzer invariant, not on this
      // text: the edge's token id is the id of the constructor parameter's type
      // (analyzer/shared/registrationGraph.ts, `pushSlot`: `tokens.getTypeId(tokenType)`), and the provider
      // registered under an interface token was checked assignable to that type
      // (analyzer/validators/TypeValidator.ts, `checkTypeCompatibility`; test: packages/core/tests/analyzer/
      // TypeValidation.test.ts, 'should throw TypeMismatchError when provider does not implement token
      // interface'). A class token is not checked there: the public `Injection` type is its only check.
      // Tested: packages/core/tests/generator/t23-getter-types.test.ts, 'keeps `unknown` and narrows at the read'.
      return className === undefined ? read : `${read} as ConstructorParameters<typeof ${className}>[${position}]`;
    }
    if (!depNode) {
      // Not registered locally — check whether it's satisfied by a parent/legacy
      // container (see DependencyGraph.parentResolvableTokens for why only this
      // subset of parent-provided tokens is safe to wire this way via a string key).
      if (graph.parentResolvableTokens?.has(depId)) {
        return called(JSON.stringify(depId));
      }
      // A bare class token from the parent: resolved by class identity, not by
      // string, so we need the actual class reference — see parentClassTokenSymbols.
      const classSymbol = graph.parentClassTokenSymbols?.get(depId);
      if (classSymbol) {
        return called(getForeignImport(classSymbol));
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
      return called(JSON.stringify(depNode.service.tokenId));
    } else if (depNode.service.tokenSymbol) {
      return called(getImport(depNode.service.tokenSymbol));
    } else if (depNode.service.implementationSymbol) {
      return called(getImport(depNode.service.implementationSymbol));
    }
    return 'undefined';
  }).join(', ');
  return { text, needs: reads && calls.internal ? ['resolveSingle'] : [] };
}

/**
 * Optimized emitter. What each alias reads, as an expression of the generated class: its canonical target, reached
 * directly (`_direct_<target>()`, no resolve event: the event is the alias token's, fired by the alias accessor), or,
 * when the target is a token a parent provides, through `_neoParent`. The chain is flattened once by
 * `aliasPlanOf`, so every alias names the end of its chain. `as <declared type>` is written only where the target's
 * accessor answers `unknown` and the alias token has a type the output can name: that read is the one place the
 * compiler cannot check, and the analyzer checked it (`aliasTypeMismatch`). A target a parent provides has no accessor
 * of its own to check an override, so the read asks `overrides` first when the profile honours them.
 */
export function aliasReadExpressions(
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  providerTypes: GetProviderTypes,
  honourOverrides: boolean,
): Map<TokenId, string> {
  const reads = new Map<TokenId, string>();
  const plan = aliasPlanOf(graph);
  if (plan === undefined) return reads;
  for (const [tokenId, node] of graph.nodes) {
    if (!plan.isAlias(tokenId)) continue;
    const target = plan.canonicalOf(tokenId);
    const declared = providerTypes(node).accessor;
    if (plan.isLocal(tokenId)) {
      const targetNode = graph.nodes.get(target);
      const known = targetNode !== undefined && providerTypes(targetNode).accessor !== undefined;
      reads.set(tokenId, `this.${getDirectName(target)}()${declared !== undefined && !known ? ` as ${declared}` : ''}`);
      continue;
    }
    const key = parentTokenKey(graph, target, getForeignImport);
    const fromParent = `this._neoParent(${key})${declared !== undefined ? ` as ${declared}` : ''}`;
    reads.set(tokenId, honourOverrides ? `(this.overrides.has(${key}) ? this._mock${declared !== undefined ? `<${declared}>` : ''}(${key}) : ${fromParent})` : fromParent);
  }
  return reads;
}

/** The runtime key of a token a parent provides, the way a dependency on it is written (see `constructorArguments`). */
export function parentTokenKey(graph: DependencyGraph, tokenId: TokenId, getForeignImport: GetImport): string {
  if (graph.parentResolvableTokens?.has(tokenId)) return JSON.stringify(tokenId);
  const symbol = graph.parentClassTokenSymbols?.get(tokenId);
  if (symbol) return getForeignImport(symbol);
  throw new Error(
    `[Generator] Cannot read '${getSimpleName(tokenId)}' from a parent/legacy container for an alias: ` +
    `no registration provides it, and no symbol could be captured to reference it. Register it in this container or in the parent.`,
  );
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
  // An alias has no lifecycle of its own: it is the one of the registration its chain ends at.
  const plan = aliasPlanOf(graph);
  const node = graph.nodes.get(plan?.isAlias(dep.tokenId) ? plan.canonicalOf(dep.tokenId) : dep.tokenId);
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
 * The lines are the body of the read member of the declaration: they read from `host`, answer `unknown`, and the
 * lease asserts the type the user's factory text asks for (`as T`), the same contract as the public `resolve<T>(token)`.
 */
function directContextResolve(
  listed: ReturnType<typeof factoryAllowList>,
  direct: DirectReads,
  fallback: () => string,
): string {
  const locals = [...listed.locals.entries()];
  const hasOther = listed.entries.some(([key]) => !listed.locals.has(key));
  // The empty case is unreachable (the allow-list guard of the lease always throws).
  if (locals.length === 0 && !hasOther) return 'return undefined;';
  const lines = locals.map(([key, tokenId], index) => {
    const read = `return ${directRead(tokenId, direct, 'host')};`;
    return !hasOther && index === locals.length - 1 ? read : `if (token === ${key}) ${read}`;
  });
  if (hasOther) lines.push(`return ${fallback()}(token);`);
  return lines.join('\n    ');
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
function emitInvocation(warmup: string, release: string, hasAsync: boolean): string {
  // The flag covers the synchronous factory call only, not an await continuation.
  // Sync containers never read it: their initialize() does not branch on _syncInit.
  const call = `const __neoResult = userFactory(__neoContext);
      if (__neoResult && typeof (__neoResult as { then?: unknown }).then === 'function') {
        return Promise.resolve(__neoResult).then(
          (value) => { __neoExpire(); ${release} return value; },
          (err) => { __neoExpire(); ${release} throw err; },
        );
      }
      __neoExpire();
      ${release}
      return __neoResult;`;
  const resultBlock = hasAsync
    ? `this._syncInit += 1;
    try {
      ${call}
    } finally {
      this._syncInit -= 1;
    }`
    : call;
  return `try {
    ${warmup}
    ${resultBlock}
  } catch (__neoThrown) { __neoExpire(); ${release} throw __neoThrown; }`;
}

/** What a factory emits: the body of its creator, and the static members that belong to its declaration. */
interface FactoryBody {
  body: Fragment;
  /** Static members of the generated class (the policy and the read of a declared factory). Empty for an opaque factory. */
  members: string;
}

/**
 * The type the copied user factory is written against: the public `Factory<T>` return, `T | PromiseLike<T>`
 * (packages/neosyringe/src/types.ts:189), for every factory. The analyzer flags `isAsync` only for an `async` function
 * or a return type named `Promise`/`PromiseLike` (packages/core/src/analyzer/parsers/InjectionParser.ts:647-665), so a union
 * with a promise or a thenable class is a valid factory that the flag does not tell apart. A provider type the output
 * can name types the factory, so a factory that does not fit its registration is an error in the output.
 * `unknown` where the type has no name.
 */
function factoryType(declared: string | undefined, names: ManyNames): string {
  const answer = declared === undefined ? 'unknown' : `${declared} | PromiseLike<${declared}>`;
  return `(context: ${factoryContextType(names)}) => ${answer}`;
}

function emitFactoryBody(
  service: DependencyNode['service'],
  graph: DependencyGraph,
  getImport: GetImport,
  hasAsync: boolean,
  closed: boolean,
  direct: DirectReads | undefined,
  copy: UserCopy,
  className: string,
  factoryId: string,
  declared: string | undefined,
  names: ManyNames = DEFAULT_MANY_NAMES,
): FactoryBody {
  const userFactory = concat(
    service.factorySource === undefined
      ? [generatedText('undefined')]
      : copy(service.factorySource, service.factoryOrigin, service.factoryRewrites),
  );
  const label = JSON.stringify(getSimpleName(service.tokenId));
  const opaqueFactory = service.opaque === true;
  const listed = factoryAllowList(service, graph, getImport);
  const allowed = listed.entries;
  const callsOn = (receiver: string): ReturnType<typeof resolutionCalls> =>
    resolutionCalls(hasAsync, closed || direct !== undefined, receiver);
  // A helper is a need only where its call is written into the text below.
  const needs = new Set<HelperId>();
  const one = (receiver = 'this'): string => {
    const calls = callsOn(receiver);
    if (calls.internal) needs.add('resolveSingle');
    return calls.one;
  };
  const all = (receiver = 'this'): string => {
    const calls = callsOn(receiver);
    if (calls.internal) needs.add('resolveAll');
    return calls.all;
  };
  const warmupLines: string[] = [];
  if (!opaqueFactory) {
    for (const [key, isAll] of allowed) {
      const depIsTransient = listed.skipWarm.get(key) === true;
      if (depIsTransient) continue;
      const local = listed.locals.get(key);
      if (direct && local !== undefined && !isAll) {
        warmupLines.push(`${directRead(local, direct)};`);
        continue;
      }
      warmupLines.push(isAll ? `${all()}(${key});` : `${one()}(${key});`);
    }
  }
  const warmup = warmupLines.join('\n    ');
  const holdStart = '';
  const release = '';
  const typedFactory = `const userFactory: ${factoryType(declared, names)} =`;
  if (opaqueFactory) {
    const expireStmt = 'const __neoExpire = () => { __neoExpired = true; };';
    const failStmt = `const __neoFail = (code: string, detail: string): never => {
      const error = new Error(code + ': factory ' + ${label} + ' ' + detail) as Error & { code: string };
      error.code = code;
      throw error;
    };`;
    // The batch reads through the context's own `resolve`, after its expiry check: it never reaches the container behind it.
    const manyFunction = manyContextFunction(
      names,
      '__neoResolveMany',
      '__neoContext.resolve',
      "if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');",
    );
    const opaqueBody = fragment`${typedFactory} ${userFactory};
    let __neoExpired = false;
    ${expireStmt}
    ${failStmt}
    ${manyFunction}
    const __neoContext = {
      resolve: <T,>(token: unknown): T => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        return ${one()}<T>(token);
      },
      resolveAll: <T,>(token: unknown): T[] => {
        if (__neoExpired) __neoFail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');
        return ${all()}<T>(token);
      },
      resolveMany: __neoResolveMany,
    };
    ${holdStart}
    ${emitInvocation('', release, hasAsync)}`;
    return { body: withNeeds(opaqueBody, [...needs]), members: '' };
  }
  // The read member answers `unknown` for the token of the call, from the `host` it is given.
  const resolveTail = direct
    ? directContextResolve(listed, direct, () => one('host'))
    : `return ${one('host')}(token);`;
  // No declared `all` dependency: the lease refuses every resolveAll, this line is never reached. It still has to be a list.
  const resolveAllTail = direct && !allowed.some(([, isAll]) => isAll) ? 'return [];' : `return ${all('host')}(token);`;
  const entries: PolicyEntry[] = allowed.map(([key, isAll]) => ({ keyExpression: key, mode: isAll ? 'all' : 'simple' }));
  const members = `\n  ${emitFactoryPolicy(className, factoryId, entries)}\n  ${emitFactoryRead(className, factoryId, `if (all) ${resolveAllTail}\n    ${resolveTail}`)}`;
  const declaredBody = fragment`${typedFactory} ${userFactory};
    ${emitLeaseOpen(className, factoryId, label)}
    ${holdStart}
    ${emitInvocation(warmup, release, hasAsync)}`;
  return { body: withNeeds(declaredBody, [...needs, 'factoryPolicy', 'factoryLease']), members };
}

/** A captured useValue is read once. Hand-built graphs keep the original expression. */
function capturedValue(node: DependencyNode, copy: UserCopy): Piece {
  const { valueCapture, valueSource, valueOrigin, valueRewrites } = node.service;
  if (valueCapture !== undefined) return valueCapture;
  if (valueSource !== undefined) return concat(copy(valueSource, valueOrigin, valueRewrites));
  return 'undefined';
}

/**
 * One `private create_X(): <type> { ... }` method, then the static members of its declaration. A creator with no type
 * of its own answers `unknown`: that is every factory's, because the thenable branch of the invocation may return a promise.
 */
function creator(factoryId: string, body: Piece, needs: readonly HelperId[] = [], returns = 'unknown', members = ''): Fragment {
  return withNeeds(fragment`
  private ${factoryId}(): ${returns} {
    ${body}
  }${members}`, needs);
}

/**
 * The `new Class(args)` of a class provider, for an accessor that builds it in place. The caller holds the class
 * symbol, which only a class registration has (packages/core/src/analyzer/graphAdapter.ts:453 drops one without it, and
 * the value and factory nodes at :406 and :432 set none). It does not declare the generic resolver its arguments call
 * (only `resolveSingle`, :194 of this file): the open public `resolve` already asks for it
 * (packages/core/src/generator/DirectEmitter.ts:258), and an accessor is inlined in open mode only.
 */
export function constructionExpression(
  node: DependencyNode,
  symbol: ts.Symbol,
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync: boolean,
  closed: boolean,
  direct: DirectReads | undefined,
  providerTypes: GetProviderTypes,
): string {
  const className = getImport(symbol);
  const args = constructorArguments(node.dependencies, graph, getImport, getForeignImport, hasAsync, closed, direct, className, providerTypes);
  return `new ${className}(${args.text})`;
}

/** `return new Class(args);`, with the need of the generic resolver its arguments call. */
function construction(
  node: DependencyNode,
  graph: DependencyGraph,
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync: boolean,
  closed: boolean,
  direct: DirectReads | undefined,
  className: string,
  providerTypes: GetProviderTypes,
): { body: string; needs: HelperId[] } {
  const args = constructorArguments(node.dependencies, graph, getImport, getForeignImport, hasAsync, closed, direct, className, providerTypes);
  return { body: `return new ${className}(${args.text});`, needs: args.needs };
}

/**
 * The class a hand-built caller declares its factories in, when it does not say: the statics of a declared factory
 * are members of that class. The two emitters of the generator always pass the name of the class they write.
 */
const DEFAULT_CLASS_NAME = 'NeoContainer';

/** Generates a factory method for each service in topological order. */
export function generateFactories(
  graph: DependencyGraph,
  sorted: TokenId[],
  getImport: GetImport,
  getForeignImport: GetImport,
  hasAsync = false,
  closed = false,
  direct?: DirectReads,
  copy: UserCopy = generatedCopy,
  providerTypes: GetProviderTypes = noProviderTypes,
  className = DEFAULT_CLASS_NAME,
  inlined: ReadonlySet<TokenId> = new Set(),
  names: ManyNames = DEFAULT_MANY_NAMES,
): Fragment[] {
  const factories: Fragment[] = [];

  for (const tokenId of sorted) {
    const node = graph.nodes.get(tokenId);
    if (!node) continue;
    if (node.service.type === 'parent') continue;
    // An alias builds nothing and keeps nothing: its accessor reads its target, there is no creator.
    if (node.service.type === 'alias') continue;
    // A creator the accessor writes in its own body has no method of its own.
    if (inlined.has(tokenId)) continue;

    const factoryId = getFactoryName(tokenId);

    // A scope input has no provider: its creator reads the value the scope was given.
    if (node.service.inputSlot !== undefined) {
      factories.push(creator(factoryId, fragment`return ${inputRead(node.service.inputSlot)};`));
      continue;
    }

    if (node.service.type === 'value' && node.service.valueSource !== undefined) {
      factories.push(creator(factoryId, fragment`return ${capturedValue(node, copy)};`, [], providerTypes(node).creator));
      continue;
    }

    if (node.service.type === 'factory' && node.service.factorySource) {
      const emitted = emitFactoryBody(node.service, graph, getImport, hasAsync, closed, direct, copy, className, factoryId, providerTypes(node).accessor, names);
      factories.push(creator(factoryId, emitted.body, emitted.body.needs, 'unknown', emitted.members));
    } else {
      if (!node.service.implementationSymbol) {
        throw new Error(
          `[Generator] No implementation symbol for token '${tokenId}'. ` +
          `This is likely a bug — ensure all non-factory registrations have a provider class.`
        );
      }
      const className = getImport(node.service.implementationSymbol);
      const built = construction(node, graph, getImport, getForeignImport, hasAsync, closed, direct, className, providerTypes);
      factories.push(creator(factoryId, built.body, built.needs, providerTypes(node).creator));
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
  copy: UserCopy = generatedCopy,
  providerTypes: GetProviderTypes = noProviderTypes,
  className = DEFAULT_CLASS_NAME,
  names: ManyNames = DEFAULT_MANY_NAMES,
): Fragment[] {
  const factories: Fragment[] = [];
  if (!graph.multiNodes) return factories;

  for (const [tokenId, nodes] of graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${getFactoryName(tokenId)}_${index}`;

      if (node.service.type === 'factory' && node.service.factorySource) {
        const emitted = emitFactoryBody(node.service, graph, getImport, hasAsync, closed, direct, copy, className, factoryId, providerTypes(node).accessor, names);
        factories.push(creator(factoryId, emitted.body, emitted.body.needs, 'unknown', emitted.members));
      } else if (node.service.type === 'value' && node.service.valueSource !== undefined) {
        factories.push(creator(factoryId, fragment`return ${capturedValue(node, copy)};`, [], providerTypes(node).creator));
      } else {
        if (!node.service.implementationSymbol) return;
        const className = getImport(node.service.implementationSymbol);
        const built = construction(node, graph, getImport, getForeignImport, hasAsync, closed, direct, className, providerTypes);
        factories.push(creator(factoryId, built.body, built.needs, providerTypes(node).creator));
      }
    });
  }

  return factories;
}
