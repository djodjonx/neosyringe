import type { AnalysisError, ConfigGraph, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import * as ts from 'typescript';

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

    // Collect all available tokens in this context
    const availableTokens = this.collectAvailableTokens(config, context);

    // Check each local injection for missing dependencies
    for (const [_tokenId, info] of config.localInjections) {
      const requiredDeps = this.dependencyAnalyzer.getRequiredDependencies(info.definition);

      for (const depTokenId of requiredDeps) {
        // Check if the dependency is available directly OR as an interface token
        const isAvailable = availableTokens.has(depTokenId) ||
                           availableTokens.has(`useInterface<${depTokenId}>()`);

        if (!isAvailable) {
          // Find the token node for better error positioning
          // Use info.node (the injection object) as fallback
          const tokenNode = this.findTokenNode(info.node);

          // IMPORTANT: We must use the config's sourceFile because the node
          // comes from parsing that file. Using node.getSourceFile() can fail
          // if the node doesn't have proper parent references.
          const errorNode = tokenNode || info.node;
          const sourceFile = config.sourceFile;

          errors.push({
            type: 'missing',
            message: `Missing injection: '${depTokenId}' required by '${info.tokenText}' is not registered in this ${config.type === 'builder' ? 'builder nor its parents/extends' : 'partial config'}`,
            node: errorNode,
            sourceFile: sourceFile,
            context: {
              tokenText: depTokenId,
            },
          });
        }
      }
    }

    return errors;
  }

  /**
   * Finds the token property node within an injection object for better error positioning.
   * Returns the entire property assignment (e.g., "token: UserService") not just the value,
   * because the value might be an imported symbol whose AST node is in a different file.
   */
  private findTokenNode(injectionNode: ts.Node): ts.Node | null {
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
