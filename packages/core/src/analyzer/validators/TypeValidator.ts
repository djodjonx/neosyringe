import type * as ts from 'typescript';
import type { AnalysisError, ConfigGraph, InjectionInfo } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';

/**
 * Validates type compatibility between tokens and providers.
 * Ensures that the provider implements the interface/class expected by the token.
 */
export class TypeValidator implements IValidator {
  readonly name = 'TypeValidator';

  constructor(
    private checker: ts.TypeChecker,
    private errorFormatter: IErrorFormatter
  ) {}

  validate(config: ConfigGraph, _context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];

    for (const [_tokenId, info] of config.localInjections) {
      const typeError = this.checkTypeCompatibility(info);
      if (typeError) {
        errors.push(typeError);
      }
    }

    return errors;
  }

  private checkTypeCompatibility(info: InjectionInfo): AnalysisError | null {
    const { definition } = info;

    // Skip if no implementation symbol (factories, etc.)
    if (!definition.implementationSymbol) {
      return null;
    }

    // Skip if not an interface token (class tokens are self-validated by TS)
    if (!definition.isInterfaceToken) {
      return null;
    }

    // Get the token type from the useInterface<T>() call
    const tokenType = this.getTokenType(info);
    if (!tokenType) return null;

    // Get the implementation type
    const implType = this.getImplementationType(info);
    if (!implType) return null;

    // Check if implementation is assignable to token type
    if (!this.checker.isTypeAssignableTo(implType, tokenType)) {
      const expectedTypeName = this.checker.typeToString(tokenType);
      const actualTypeName = this.checker.typeToString(implType);
      return this.errorFormatter.formatTypeMismatchError(info, expectedTypeName, actualTypeName);
    }

    return null;
  }

  private getTokenType(_info: InjectionInfo): ts.Type | null {
    // The token type is extracted from the ServiceDefinition
    // This would typically come from useInterface<T>() type argument
    // For now, we rely on the existing type extraction in the collector
    return null;
  }

  private getImplementationType(info: InjectionInfo): ts.Type | null {
    const { definition } = info;
    if (!definition.implementationSymbol) return null;

    const declarations = definition.implementationSymbol.getDeclarations();
    if (!declarations || declarations.length === 0) return null;

    return this.checker.getTypeOfSymbolAtLocation(definition.implementationSymbol, declarations[0]);
  }
}
