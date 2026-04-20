import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { AnalysisError, ConfigGraph, InjectionInfo } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';
import { PropertyFinder } from '../utils/PropertyFinder';

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

    if (!definition.implementationSymbol) return null;
    if (!definition.isInterfaceToken) return null;
    if (definition.type === 'value') return null; // no class to type-check

    const tokenType = this.getTokenType(info);
    if (!tokenType) return null;

    const implType = this.getImplementationType(info);
    if (!implType) return null;

    if (!this.checker.isTypeAssignableTo(implType, tokenType)) {
      const expectedTypeName = this.checker.typeToString(tokenType);
      const actualTypeName = this.checker.typeToString(implType);
      return this.errorFormatter.formatTypeMismatchError(info, expectedTypeName, actualTypeName);
    }

    return null;
  }

  /**
   * Extracts the interface type T from the useInterface<T>() call in the injection object.
   * The injection object is { token: useInterface<T>(), provider: Impl }.
   */
  private getTokenType(info: InjectionInfo): ts.Type | null {
    const tokenProp = PropertyFinder.findTokenAssignment(info.node);
    if (!tokenProp) return null;

    const tokenExpr = tokenProp.initializer;
    if (!TSContext.ts.isCallExpression(tokenExpr)) return null;
    if (!tokenExpr.typeArguments || tokenExpr.typeArguments.length === 0) return null;

    try {
      return this.checker.getTypeFromTypeNode(tokenExpr.typeArguments[0]);
    } catch {
      return null;
    }
  }

  private getImplementationType(info: InjectionInfo): ts.Type | null {
    const { definition } = info;
    if (!definition.implementationSymbol) return null;

    // getDeclaredTypeOfSymbol returns the instance type (e.g., ConsoleLogger),
    // whereas getTypeOfSymbolAtLocation returns the constructor type (typeof ConsoleLogger)
    // which is not structurally assignable to an interface.
    return this.checker.getDeclaredTypeOfSymbol(definition.implementationSymbol);
  }
}
