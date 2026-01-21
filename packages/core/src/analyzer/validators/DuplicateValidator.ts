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

  private validateInheritedDuplicates(
    config: ConfigGraph,
    inheritedTokens: Map<TokenId, InheritedToken>
  ): AnalysisError[] {
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
