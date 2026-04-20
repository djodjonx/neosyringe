import type { AnalysisError, ConfigGraph, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { PropertyFinder } from '../utils/PropertyFinder';

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
      const requiredDeps = this.dependencyAnalyzer.getRequiredDependencies(info.definition);
      for (const depTokenId of requiredDeps) {
        if (!availableTokens.has(depTokenId)) {
          const tokenNode = PropertyFinder.findTokenAssignment(info.node);
          const errorNode = tokenNode || info.node;
          errors.push({
            type: 'missing',
            message: `Missing injection: '${depTokenId}' required by '${info.tokenText}' is not registered in this ${config.type === 'builder' ? 'builder nor its parents/extends' : 'partial config'}`,
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
}
