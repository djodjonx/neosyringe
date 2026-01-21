import type { AnalysisError, ConfigGraph, TokenId, InheritedToken } from '../types';

/**
 * Context provided to validators during validation.
 */
export interface ValidationContext {
  /** All configs in the program */
  allConfigs: Map<string, ConfigGraph>;

  /** Inherited tokens (resolved by TokenResolver) - for builders only */
  inheritedTokens?: Map<TokenId, InheritedToken>;

  /** Already visited configs (for cycle detection) */
  visited?: Set<string>;
}

/**
 * Interface for validators.
 * Implement this to add new validation rules.
 */
export interface IValidator {
  /** Validator name for logging/debugging */
  readonly name: string;

  /** Validate a config and return errors */
  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[];
}

/**
 * Composite validator that combines multiple validators.
 * Use this to compose validation rules.
 */
export class CompositeValidator implements IValidator {
  readonly name = 'CompositeValidator';

  constructor(private validators: IValidator[] = []) {}

  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];

    for (const validator of this.validators) {
      errors.push(...validator.validate(config, context));
    }

    return errors;
  }

  /** Add a validator (for extensibility) */
  addValidator(validator: IValidator): this {
    this.validators.push(validator);
    return this;
  }

  /** Remove a validator by name */
  removeValidator(name: string): this {
    this.validators = this.validators.filter((v) => v.name !== name);
    return this;
  }

  /** Get all validators */
  getValidators(): readonly IValidator[] {
    return this.validators;
  }
}
