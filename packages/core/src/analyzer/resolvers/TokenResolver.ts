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

    this.resolveRecursive(config, nameIndex, inherited, visited, []);

    return inherited;
  }

  private resolveRecursive(
    config: ConfigGraph,
    nameIndex: Map<string, ConfigGraph>,
    inherited: Map<TokenId, InheritedToken>,
    visited: Set<string>,
    chain: string[]
  ): void {
    // Cycle detection
    if (visited.has(config.name)) {
      throw new CycleError([...chain, config.name]);
    }
    visited.add(config.name);

    // 1. useContainer (highest priority) - resolve recursively first
    if (config.useContainerRef) {
      const parent = this.findConfigByName(nameIndex, config.useContainerRef);
      if (parent) {
        // Resolve parent's inheritance chain first
        this.resolveRecursive(
          parent,
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
    for (const partialName of config.extendsRefs) {
      const partial = this.findConfigByName(nameIndex, partialName);
      if (partial) {
        // Partials don't have extends/useContainer, so just add their tokens
        this.addTokensFromConfig(partial, inherited, 'extends', chain);
      }
    }
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
      index.set(config.name, config);
    }
    return index;
  }

  private addTokensFromConfig(
    config: ConfigGraph,
    inherited: Map<TokenId, InheritedToken>,
    type: 'parent' | 'extends',
    chain: string[]
  ): void {
    for (const [tokenId, info] of config.localInjections) {
      // First occurrence wins (priority already established by order)
      if (!inherited.has(tokenId)) {
        inherited.set(tokenId, {
          tokenId,
          tokenText: info.tokenText,
          source: {
            name: config.name,
            type,
            chain: chain.length > 0 ? [...chain] : undefined,
          },
        });
      }
    }
  }
}
