import type { SourceFile, Node } from 'typescript';
import type { AnalysisError, InjectionInfo, TokenSource } from '../types';
import { PropertyFinder } from '../utils/PropertyFinder';

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
    const errorNode = PropertyFinder.findTokenAssignment(injection.node) ?? injection.node;

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
    // Use the full registration object so the error spans both token and provider,
    // making it clear which combination is incompatible.
    const errorNode = injection.node;

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
