import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import { resolveNeoMarker } from '../shared/markerProvenance';

/**
 * Utility functions for identifying specific call expressions in the AST.
 *
 * These utilities help identify NeoSyringe-specific function calls like
 * defineBuilderConfig, definePartialConfig, and declareContainerTokens.
 *
 * @example
 * ```typescript
 * if (CallExpressionUtils.isDefineBuilderConfig(node)) {
 *   // Handle defineBuilderConfig call
 * }
 * ```
 */
export class CallExpressionUtils {
  /**
   * Checks if a call expression is `defineBuilderConfig(...)`.
   *
   * @param node - The call expression to check
   * @returns True if the call is defineBuilderConfig
   *
   * @example
   * ```typescript
   * const node = ...; // defineBuilderConfig({ ... })
   * CallExpressionUtils.isDefineBuilderConfig(node); // true
   * ```
   */
  static isDefineBuilderConfig(node: ts.CallExpression, checker?: ts.TypeChecker): boolean {
    if (checker && typeof checker.getSymbolAtLocation === 'function') {
      return resolveNeoMarker(checker, node) === 'defineBuilderConfig';
    }
    const expression = node.expression;
    return TSContext.ts.isIdentifier(expression) && expression.text === 'defineBuilderConfig';
  }

  /**
   * Checks if a call expression is `definePartialConfig(...)`.
   *
   * @param node - The call expression to check
   * @returns True if the call is definePartialConfig
   *
   * @example
   * ```typescript
   * const node = ...; // definePartialConfig({ ... })
   * CallExpressionUtils.isDefinePartialConfig(node); // true
   * ```
   */
  static isDefinePartialConfig(node: ts.CallExpression, checker?: ts.TypeChecker): boolean {
    if (checker && typeof checker.getSymbolAtLocation === 'function') {
      return resolveNeoMarker(checker, node) === 'definePartialConfig';
    }
    const expression = node.expression;
    return TSContext.ts.isIdentifier(expression) && expression.text === 'definePartialConfig';
  }

  /**
   * Checks if a call expression is `declareContainerTokens<T>()`.
   *
   * Used to declare tokens provided by legacy containers.
   *
   * @param node - The call expression to check
   * @returns True if the call is declareContainerTokens
   *
   * @example
   * ```typescript
   * const node = ...; // declareContainerTokens<{ ILogger: ILogger }>()
   * CallExpressionUtils.isDeclareContainerTokens(node); // true
   * ```
   */
  static isDeclareContainerTokens(node: ts.CallExpression, checker?: ts.TypeChecker): boolean {
    if (checker && typeof checker.getSymbolAtLocation === 'function') {
      return resolveNeoMarker(checker, node) === 'declareContainerTokens';
    }
    return TSContext.ts.isIdentifier(node.expression) &&
           node.expression.text === 'declareContainerTokens';
  }

  /**
   * Checks if a call expression is any NeoSyringe config call.
   *
   * @param node - The call expression to check
   * @returns True if the call is a NeoSyringe config function
   */
  static isConfigCall(node: ts.CallExpression, checker?: ts.TypeChecker): boolean {
    return this.isDefineBuilderConfig(node, checker) ||
           this.isDefinePartialConfig(node, checker) ||
           this.isDeclareContainerTokens(node, checker);
  }
}
