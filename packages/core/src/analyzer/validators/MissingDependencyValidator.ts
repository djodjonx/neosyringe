import type { AnalysisError, ConfigGraph, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { findTokenAssignment } from '../utils/PropertyFinder';
import { getSimpleName } from '../utils/TokenUtils';

/**
 * Validates that all required dependencies are available in the container.
 * - For partialConfig: checks only local injections
 * - For defineBuilder: checks local + parent + extends (recursive)
 */
export class MissingDependencyValidator implements IValidator {
  readonly name = 'MissingDependencyValidator';

  constructor(
    private errorFormatter: IErrorFormatter,
    private dependencyAnalyzer: DependencyAnalyzer
  ) {}

  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];

    const availableTokens = this.collectAvailableTokens(config, context);

    const checkInfo = (info: import('../types').InjectionInfo) => {
      const requiredDeps = this.dependencyAnalyzer.getRequiredDependencies(
        info.definition,
        availableTokens  // pass so property tokens are matched correctly
      );
      for (const depTokenId of requiredDeps) {
        if (!availableTokens.has(depTokenId)) {
          const tokenNode = findTokenAssignment(info.node);
          const errorNode = tokenNode || info.node;
          errors.push({
            type: 'missing',
            message: `Missing injection: '${getSimpleName(depTokenId)}' required by '${info.tokenText}' is not registered in this ${config.type === 'builder' ? 'builder nor its parents/extends' : 'partial config'}`,
            node: errorNode,
            sourceFile: config.sourceFile,
            context: { tokenText: depTokenId },
          });
        }
      }
    };

    for (const [_tokenId, info] of config.localInjections) {
      checkInfo(info);
    }

    if (config.multiInjections) {
      for (const [_tokenId, infos] of config.multiInjections) {
        for (const info of infos) {
          checkInfo(info);
        }
      }
    }

    // Phase 2: verify builder satisfies all partial expects
    if (config.type === 'builder') {
      errors.push(...this.checkPartialExpectsSatisfied(config, context, availableTokens));
    }

    return errors;
  }

  /**
   * Collects all available tokens in the current context.
   * - partialConfig: only local tokens
   * - defineBuilder: local + inherited from parent/extends + legacy parent tokens
   */
  private collectAvailableTokens(
    config: ConfigGraph,
    context: ValidationContext
  ): Set<TokenId> {
    const available = new Set<TokenId>();

    // Add local tokens
    for (const tokenId of config.localInjections.keys()) {
      available.add(tokenId);
    }

    // Add local multi-registration tokens — a consumer of a multi-registered
    // token is valid; the token IS provided, just via resolveAll().
    if (config.multiInjections) {
      for (const tokenId of config.multiInjections.keys()) {
        available.add(tokenId);
      }
    }

    // For partials: add tokens declared in `expects` — they will be provided
    // by the host BuilderConfig at assembly time, not by the partial itself.
    if (config.type === 'partial' && config.expectedExternalTokens) {
      for (const tokenId of config.expectedExternalTokens) {
        available.add(tokenId);
      }
    }

    // For builders, add inherited tokens
    if (config.type === 'builder' && context.inheritedTokens) {
      for (const tokenId of context.inheritedTokens.keys()) {
        available.add(tokenId);
      }
    }

    // For builders with legacy parent, add legacy parent tokens
    if (config.type === 'builder' && config.legacyParentTokens) {
      for (const tokenId of config.legacyParentTokens) {
        available.add(tokenId);
      }
    }

    return available;
  }

  /**
   * Phase 2: verifies that for each partial extended by this builder, all tokens
   * declared in the partial's `expects` are actually provided by the builder's
   * available token set (own injections + inherited + legacy parent).
   */
  private checkPartialExpectsSatisfied(
    config: ConfigGraph,
    context: ValidationContext,
    availableTokens: Set<TokenId>
  ): AnalysisError[] {
    const errors: AnalysisError[] = [];

    // Strict tokenId comparison: when the same interface is imported from the same
    // declaration file in both the partial and the builder, their tokenIds are identical
    // (the hash is derived from the symbol's declaration location, not the call site).
    // Using strict comparison preserves the hash-based collision protection.
    for (const extendRef of config.extendsRefs) {
      const partial = this.findPartialConfigByName(extendRef, context.allConfigs);
      if (!partial?.expectedExternalTokens) continue;

      for (const tokenId of partial.expectedExternalTokens) {
        if (!availableTokens.has(tokenId)) {
          errors.push({
            type: 'missing',
            message: `Missing token: '${getSimpleName(tokenId)}' is declared in '${extendRef}.expects' but is not provided by this builder or its parent container.`,
            node: config.node,
            sourceFile: config.sourceFile,
            context: { tokenText: tokenId },
          });
        }
      }
    }

    return errors;
  }

  /** Finds a partial ConfigGraph by its variable name across all collected configs. */
  private findPartialConfigByName(
    name: string,
    allConfigs: Map<string, ConfigGraph>
  ): ConfigGraph | undefined {
    for (const cfg of allConfigs.values()) {
      if (cfg.name === name && cfg.type === 'partial') return cfg;
    }
    return undefined;
  }
}
