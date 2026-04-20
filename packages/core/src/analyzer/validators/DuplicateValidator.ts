import type { AnalysisError, ConfigGraph, InheritedToken, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';

/**
 * Validates duplicate registrations.
 * - Internal duplicates (same config)
 * - Inherited duplicates (from parent/extends) for builders
 */
export class DuplicateValidator implements IValidator {
  readonly name = 'DuplicateValidator';

  constructor(private errorFormatter: IErrorFormatter) {}

  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];

    // 1. Internal duplicates
    errors.push(...this.validateInternalDuplicates(config));

    // 2. Inherited duplicates (builders only)
    if (config.type === 'builder' && context.inheritedTokens) {
      errors.push(...this.validateInheritedDuplicates(config, context.inheritedTokens));
    }

    // 3. Legacy parent duplicates (builders with declareContainerTokens parent)
    if (config.type === 'builder' && config.legacyParentTokens) {
      errors.push(...this.validateLegacyDuplicates(config));
    }

    return errors;
  }

  private validateInternalDuplicates(config: ConfigGraph): AnalysisError[] {
    const errors: AnalysisError[] = [];

    // Use pre-collected duplicates from ConfigCollector
    for (const duplicate of config.duplicates) {
      errors.push(
        this.errorFormatter.formatDuplicateError(duplicate, {
          name: config.name,
          type: 'internal',
        })
      );
    }

    return errors;
  }

  private validateLegacyDuplicates(config: ConfigGraph): AnalysisError[] {
    const errors: AnalysisError[] = [];

    for (const [tokenId, info] of config.localInjections) {
      if (info.isScoped) continue;
      if (config.legacyParentTokens!.has(tokenId)) {
        errors.push(
          this.errorFormatter.formatDuplicateError(info, {
            name: config.useContainerRef ?? 'legacy container',
            type: 'parent',
          })
        );
      }
    }

    return errors;
  }

  private validateInheritedDuplicates(
    config: ConfigGraph,
    inheritedTokens: Map<TokenId, InheritedToken>
  ): AnalysisError[] {
    // TODO: also check multiInjections against inherited tokens
    const errors: AnalysisError[] = [];

    for (const [tokenId, info] of config.localInjections) {
      // Skip if scoped: true (intentional override)
      if (info.isScoped) continue;

      const inherited = inheritedTokens.get(tokenId);
      if (inherited) {
        errors.push(this.errorFormatter.formatDuplicateError(info, inherited.source));
      }
    }

    return errors;
  }
}
