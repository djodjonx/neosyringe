import * as ts from 'typescript';
import type { SourceFile, Node } from 'typescript';
import type { AnalysisError, InjectionInfo, TokenSource } from '../types';

/**
 * Interface for error formatting.
 * Allows customization of error messages.
 */
export interface IErrorFormatter {
  formatDuplicateError(
    injection: InjectionInfo,
    source: TokenSource | { name: string; type: 'internal' }
  ): AnalysisError;

  formatTypeMismatchError(
    injection: InjectionInfo,
    expectedType: string,
    actualType: string
  ): AnalysisError;

  formatCycleError(
    chain: string[],
    node: Node,
    sourceFile: SourceFile
  ): AnalysisError;
}

/**
 * Default error formatter with descriptive messages.
 */
export class ErrorFormatter implements IErrorFormatter {
  /**
   * Finds the token property node within an injection object for better error positioning.
   * Returns the entire property assignment (e.g., "token: UserService") not just the value,
   * because the value might be an imported symbol whose AST node is in a different file.
   */
  private findTokenNode(injectionNode: Node): Node | null {
    if (!ts.isObjectLiteralExpression(injectionNode)) {
      return null;
    }

    for (const prop of injectionNode.properties) {
      if (ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'token') {
        // Return the entire property assignment, not just the initializer
        // This ensures the node is always in the current file
        return prop;
      }
    }

    return null;
  }

  formatDuplicateError(
    injection: InjectionInfo,
    source: TokenSource | { name: string; type: 'internal' }
  ): AnalysisError {
    let message: string;

    if (source.type === 'internal') {
      message = `Duplicate registration: '${injection.tokenText}' is already registered.`;
    } else if (source.type === 'parent') {
      message = `Duplicate registration: '${injection.tokenText}' is already registered in parent container '${source.name}'.`;
    } else {
      message = `Duplicate registration: '${injection.tokenText}' is already registered in partial '${source.name}'.`;
    }

    // Use the token node for precise error positioning
    const errorNode = this.findTokenNode(injection.node) || injection.node;

    return {
      type: 'duplicate',
      message,
      node: errorNode,
      sourceFile: errorNode.getSourceFile(),
      context: {
        tokenText: injection.tokenText,
        conflictSource: source.name,
      },
    };
  }

  formatTypeMismatchError(
    injection: InjectionInfo,
    expectedType: string,
    actualType: string
  ): AnalysisError {
    // Use the token node for precise error positioning
    const errorNode = this.findTokenNode(injection.node) || injection.node;

    return {
      type: 'type-mismatch',
      message: `Type mismatch: Provider '${actualType}' is not assignable to token type '${expectedType}'.`,
      node: errorNode,
      sourceFile: errorNode.getSourceFile(),
      context: {
        tokenText: injection.tokenText,
      },
    };
  }

  formatCycleError(
    chain: string[],
    node: Node,
    sourceFile: SourceFile
  ): AnalysisError {
    return {
      type: 'cycle',
      message: `Circular dependency detected: ${chain.join(' -> ')}`,
      node,
      sourceFile,
      context: { chain },
    };
  }
}
