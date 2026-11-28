import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { DependencyGraph, DependencyNode, TokenId } from '../types';
import type { TokenResolverService } from './TokenResolverService';

/**
 * Aliases (`useExisting`). Adapted from the reference core of topic 20 (`t20-alias.ts` of the pack): the same walk,
 * with the token id of this analyzer as key. The chain is flattened once, without recursion, so a chain of any length
 * is read in one pass and the generated code reads the canonical target directly.
 */
export type Key = TokenId;

export interface AliasLinks {
  /** The canonical provider of a token: a provider itself, or the end of its alias chain. */
  targetOf(token: Key): Key;
}

/**
 * Links every alias of `entries` (alias, direct target) to the provider its chain ends at.
 * `providerKeys` are the tokens a container can build or reach: its own registrations that are not aliases, and what
 * its parents provide. The walk refuses a token registered twice, a cycle and a target that nothing provides.
 */
export function linkAliases(
  providerKeys: ReadonlySet<Key>,
  entries: readonly (readonly [Key, Key])[],
): AliasLinks {
  const providers = new Set(providerKeys);
  const edges = new Map<Key, Key>();
  for (const [alias, target] of entries) {
    if (providers.has(alias) || edges.has(alias)) throw new Error('duplicate alias registration');
    edges.set(alias, target);
  }
  const canonical = new Map<Key, Key>();
  for (const start of edges.keys()) {
    if (canonical.has(start)) continue;
    const path: Key[] = [];
    const visiting = new Set<Key>();
    let current = start;
    while (!providers.has(current) && !canonical.has(current)) {
      if (visiting.has(current)) throw new Error('alias cycle');
      visiting.add(current);
      path.push(current);
      const target = edges.get(current);
      if (target === undefined) throw new Error('missing alias target');
      current = target;
    }
    const target = canonical.get(current) ?? current;
    for (const alias of path) canonical.set(alias, target);
  }
  return Object.freeze({
    targetOf(token: Key): Key {
      if (providers.has(token)) return token;
      const target = canonical.get(token);
      if (target === undefined) throw new Error('unknown alias token');
      return target;
    },
  });
}

/** What the generator reads of the aliases of one graph. */
export interface AliasPlan {
  /** True when the registration of `token` is an alias. */
  isAlias(token: TokenId): boolean;
  /** The canonical target of an alias: a local registration, or a token a parent provides. */
  canonicalOf(token: TokenId): TokenId;
  /** True when the canonical target of `token` is a registration of this graph. */
  isLocal(token: TokenId): boolean;
  /** The canonical targets that are registrations of this graph. Their accessor is read by an alias. */
  readonly localTargets: ReadonlySet<TokenId>;
}

const plans = new WeakMap<Map<TokenId, DependencyNode>, AliasPlan | null>();

/**
 * The plan of the aliases of a graph, or `undefined` when it has none (a container without aliases pays nothing).
 * It is built once per `nodes` table and kept with it: a graph is not changed once the generator reads it.
 */
export function aliasPlanOf(graph: DependencyGraph): AliasPlan | undefined {
  const cached = plans.get(graph.nodes);
  if (cached !== undefined) return cached ?? undefined;
  const entries: Array<readonly [Key, Key]> = [];
  const providers = new Set<Key>();
  for (const [tokenId, node] of graph.nodes) {
    const target = node.service.aliasTarget;
    if (node.service.type === 'alias' && target !== undefined) entries.push([tokenId, target.tokenId]);
    else providers.add(tokenId);
  }
  if (entries.length === 0) {
    plans.set(graph.nodes, null);
    return undefined;
  }
  const aliases = new Set(entries.map(([alias]) => alias));
  // A `scoped` alias replaces a token its parent provides: the token is the alias here, not a provider.
  for (const tokenId of graph.parentProvidedTokens ?? []) if (!aliases.has(tokenId)) providers.add(tokenId);
  for (const tokenId of graph.multiNodes?.keys() ?? []) providers.add(tokenId);
  // A target nothing provides is a refused graph (`NEO_MISSING_PROVIDER`). It is read as a token from outside, so a
  // reader of a graph that has errors (the IR) gets a plan, and the generator says which token no key can read.
  for (const [, target] of entries) if (!aliases.has(target)) providers.add(target);
  const links = linkAliases(providers, entries);
  const localTargets = new Set<TokenId>();
  for (const [alias] of entries) {
    const target = links.targetOf(alias);
    if (graph.nodes.has(target) && !aliases.has(target)) localTargets.add(target);
  }
  const plan: AliasPlan = {
    isAlias: (token) => aliases.has(token),
    canonicalOf: (token) => links.targetOf(token),
    isLocal: (token) => {
      const target = links.targetOf(token);
      return graph.nodes.has(target) && !aliases.has(target);
    },
    localTargets,
  };
  plans.set(graph.nodes, plan);
  return plan;
}

/**
 * The dependencies of a node for an order that only registrations with a provider take part in (initialization and
 * disposal): an alias is not one, so a dependency on an alias is a dependency on its canonical target.
 */
export function orderingDependencies(plan: AliasPlan | undefined, dependencies: readonly TokenId[]): TokenId[] {
  if (plan === undefined) return [...dependencies];
  return dependencies.map((dependency) => (plan.isAlias(dependency) ? plan.canonicalOf(dependency) : dependency));
}

// ---------------------------------------------------------------------------------------------------------------
// The value a token carries
// ---------------------------------------------------------------------------------------------------------------

/**
 * The type a token expression stands for: the `T` of `useInterface<T>()` or `useProperty<T>(...)`, the instance type of
 * a class. `undefined` when the checker cannot tell (no type argument, an abstract or generic shape without a
 * construct signature): the pair is then not checked.
 */
export function valueTypeOfToken(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  expression: ts.Expression,
): ts.Type | undefined {
  const resolved = tokens.resolveToInitializer(expression) ?? expression;
  if (tokens.isUseInterfaceCall(resolved) || tokens.isUsePropertyCall(resolved)) {
    const argument = resolved.typeArguments?.[0];
    return argument === undefined ? undefined : checker.getTypeFromTypeNode(argument);
  }
  const constructor = checker.getTypeAtLocation(expression);
  const signature = constructor.getConstructSignatures()[0];
  return signature?.getReturnType();
}

/** The two type names of an alias whose target does not have the value of its token, or `undefined` when it does. */
export function aliasTypeMismatch(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  token: ts.Expression,
  target: ts.Expression,
): { expected: string; actual: string } | undefined {
  const expected = valueTypeOfToken(checker, tokens, token);
  const actual = valueTypeOfToken(checker, tokens, target);
  if (expected === undefined || actual === undefined) return undefined;
  if (checker.isTypeAssignableTo(actual, expected)) return undefined;
  return { expected: checker.typeToString(expected), actual: checker.typeToString(actual) };
}

/** The `useExisting` initializer of an injection object literal. */
export function aliasTargetNode(obj: ts.ObjectLiteralExpression): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;
    if (prop.name.text === 'useExisting') return prop.initializer;
  }
  return undefined;
}

/** The text of a type-mismatch of an alias: the same as a provider that does not fit its interface token. */
export function aliasMismatchMessage(mismatch: { expected: string; actual: string }): string {
  return `Type mismatch: Provider '${mismatch.actual}' is not assignable to token type '${mismatch.expected}'.`;
}
