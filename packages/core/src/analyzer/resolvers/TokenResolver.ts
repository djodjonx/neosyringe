import type { ConfigGraph, TokenId, InheritedToken } from '../types';
import { CycleError } from '../errors/CycleError';

/**
 * Interface for resolving inherited tokens.
 */
export interface ITokenResolver {
  /** Resolve all inherited tokens for a builder config */
  resolveInheritedTokens(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>
  ): Map<TokenId, InheritedToken>;

  /**
   * The multi tokens a builder reaches through `{ all }`: the ones of its extended partials, of its
   * parents and of their partials. A closed parent only offers the multi roots it exports.
   */
  resolveInheritedMultiTokens(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>
  ): Set<TokenId>;
}

/**
 * Resolves inherited tokens from useContainer and extends.
 *
 * Priority order:
 * 1. useContainer (parent) - highest priority, recursive
 * 2. extends (partials) - in array order
 */
export class TokenResolver implements ITokenResolver {
  resolveInheritedTokens(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>
  ): Map<TokenId, InheritedToken> {
    // Build name index once for O(1) lookups in findConfigByName
    const nameIndex = this.buildNameIndex(allConfigs);
    
    const inherited = new Map<TokenId, InheritedToken>();
    const visited = new Set<string>();

    this.resolveRecursive(config, allConfigs, nameIndex, inherited, visited, []);

    return inherited;
  }

  resolveInheritedMultiTokens(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>
  ): Set<TokenId> {
    const found = new Set<TokenId>();
    this.collectMulti(config, allConfigs, this.buildNameIndex(allConfigs), found, new Set(), false);
    return found;
  }

  /**
   * A closed parent copies its exported roots and nothing else, so its own parent is not followed
   * (ParentContainerResolver.copyClosedParent). An open parent gives every multi token it holds.
   */
  private collectMulti(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
    nameIndex: Map<string, ConfigGraph>,
    found: Set<TokenId>,
    visited: Set<string>,
    asParent: boolean
  ): void {
    const identity = config.containerKey ?? config.name;
    if (visited.has(identity)) return;
    visited.add(identity);

    const closed = asParent && config.optimizationMode === 'closed';
    const exported = new Set<TokenId>([...(config.publicRoots ?? []), ...(config.publicMultiRoots ?? [])]);
    const take = (source: ConfigGraph): void => {
      for (const tokenId of source.multiInjections?.keys() ?? []) {
        if (!closed || exported.has(tokenId)) found.add(tokenId);
      }
    };
    take(config);
    for (const partial of this.partialsOf(config, allConfigs, nameIndex)) take(partial);
    if (closed || !config.useContainerRef) return;
    const parent = this.parentOf(config, allConfigs, nameIndex);
    if (parent) this.collectMulti(parent, allConfigs, nameIndex, found, visited, true);
  }

  private resolveRecursive(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
    nameIndex: Map<string, ConfigGraph>,
    inherited: Map<TokenId, InheritedToken>,
    visited: Set<string>,
    chain: string[]
  ): void {
    // Cycle detection, by configuration identity. A config without a key keeps its name.
    const identity = config.containerKey ?? config.name;
    if (visited.has(identity)) {
      throw new CycleError([...chain, config.name]);
    }
    visited.add(identity);

    // 1. useContainer (highest priority) - resolve recursively first
    if (config.useContainerRef) {
      const parent = this.parentOf(config, allConfigs, nameIndex);
      if (parent && parent.optimizationMode === 'closed') {
        // A closed parent copies its exported roots and nothing else: its own parent is not followed
        // (ParentContainerResolver.copyClosedParent).
        this.addClosedParentTokens(parent, allConfigs, nameIndex, inherited, chain);
      } else if (parent) {
        // Resolve parent's inheritance chain first
        this.resolveRecursive(
          parent,
          allConfigs,
          nameIndex,
          inherited,
          new Set(visited), // Clone to allow different branches
          [...chain, config.name]
        );

        // Then add parent's local tokens
        this.addTokensFromConfig(parent, inherited, 'parent', chain);
      }
    }

    // 2. extends (in array order)
    for (const partial of this.partialsOf(config, allConfigs, nameIndex)) {
      // Partials don't have extends/useContainer, so just add their tokens
      this.addTokensFromConfig(partial, inherited, 'extends', chain);
    }
  }

  /**
   * The parent named by `useContainer`. The collector resolved it to a configuration identity,
   * through aliases and re-exports; only a config that carries no link falls back to its name.
   */
  private parentOf(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
    nameIndex: Map<string, ConfigGraph>,
  ): ConfigGraph | undefined {
    if (config.useContainerKind === 'config' && config.useContainerKey !== undefined) {
      return allConfigs.get(config.useContainerKey);
    }
    if (config.useContainerKind === 'declared') return undefined;
    return config.useContainerRef ? this.findConfigByName(nameIndex, config.useContainerRef) : undefined;
  }

  /** The partials in `extends`, in array order, by identity. Names are only used when no element has a link. */
  private partialsOf(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
    nameIndex: Map<string, ConfigGraph>,
  ): ConfigGraph[] {
    const partials: ConfigGraph[] = [];
    if (config.extendsLinks) {
      for (const link of config.extendsLinks) {
        const partial = allConfigs.get(link.key);
        if (partial) partials.push(partial);
      }
      return partials;
    }
    for (const partialName of config.extendsRefs) {
      const partial = this.findConfigByName(nameIndex, partialName);
      if (partial) partials.push(partial);
    }
    return partials;
  }

  /**
   * Find a config by its variable name using the pre-built name index.
   * This is O(1) instead of O(n) iteration.
   */
  private findConfigByName(
    nameIndex: Map<string, ConfigGraph>,
    variableName: string
  ): ConfigGraph | undefined {
    return nameIndex.get(variableName);
  }

  /**
   * Build a name index that maps variable names to configs for O(1) lookups.
   */
  private buildNameIndex(allConfigs: Map<string, ConfigGraph>): Map<string, ConfigGraph> {
    const index = new Map<string, ConfigGraph>();
    for (const config of allConfigs.values()) {
      // First occurrence wins — matches the original linear-search behavior.
      // Omitting this guard would silently change to last-wins semantics.
      // Variable names should be unique, but if two files define a config
      // with the same name, the first one in iteration order takes precedence.
      if (!index.has(config.name)) {
        index.set(config.name, config);
      }
    }
    return index;
  }

  /** The exported roots of a closed parent, from its own injections and from its partials. */
  private addClosedParentTokens(
    parent: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
    nameIndex: Map<string, ConfigGraph>,
    inherited: Map<TokenId, InheritedToken>,
    chain: string[]
  ): void {
    const exported = new Set<TokenId>([...(parent.publicRoots ?? []), ...(parent.publicMultiRoots ?? [])]);
    this.addTokensFromConfig(parent, inherited, 'parent', chain, exported);
    for (const partial of this.partialsOf(parent, allConfigs, nameIndex)) {
      this.addTokensFromConfig(partial, inherited, 'parent', chain, exported, parent.name);
    }
  }

  private addTokensFromConfig(
    config: ConfigGraph,
    inherited: Map<TokenId, InheritedToken>,
    type: 'parent' | 'extends',
    chain: string[],
    only?: ReadonlySet<TokenId>,
    sourceName: string = config.name
  ): void {
    for (const [tokenId, info] of config.localInjections) {
      if (only && !only.has(tokenId)) continue;
      // First occurrence wins (priority already established by order)
      if (!inherited.has(tokenId)) {
        inherited.set(tokenId, {
          tokenId,
          tokenText: info.tokenText,
          source: {
            name: sourceName,
            type,
            chain: chain.length > 0 ? [...chain] : undefined,
          },
        });
      }
    }
  }
}
