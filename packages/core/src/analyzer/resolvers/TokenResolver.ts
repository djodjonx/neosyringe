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
    const inherited = new Map<TokenId, InheritedToken>();
    const visited = new Set<string>();

    this.resolveRecursive(config, allConfigs, inherited, visited, []);

    return inherited;
  }

  private resolveRecursive(
    config: ConfigGraph,
    allConfigs: Map<string, ConfigGraph>,
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
      const parent = allConfigs.get(config.useContainerRef);
      if (parent) {
        // Resolve parent's inheritance chain first
        this.resolveRecursive(
          parent,
          allConfigs,
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
      const partial = allConfigs.get(partialName);
      if (partial) {
        // Partials don't have extends/useContainer, so just add their tokens
        this.addTokensFromConfig(partial, inherited, 'extends', chain);
      }
    }
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
