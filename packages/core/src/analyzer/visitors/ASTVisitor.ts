import * as ts from 'typescript';

/**
 * Results collected by the ASTVisitor during traversal.
 */
export interface VisitorResults {
  /** Variable names of containers used as parents (via useContainer) */
  parentContainers: Set<string>;

  /** All defineBuilderConfig call expressions found */
  builderConfigs: ts.CallExpression[];

  /** All definePartialConfig call expressions found */
  partialConfigs: ts.CallExpression[];

  /** Variable names referenced in extends arrays */
  extendsReferences: Set<string>;
}

/**
 * Unified AST visitor that collects all DI-related information in a single pass.
 *
 * Previously, the analyzer made 3 separate passes over the AST:
 * 1. Identify parent containers
 * 2. Parse all containers
 * 3. Collect partials used in extends
 *
 * This visitor combines all three into a single traversal for better performance,
 * especially important for large projects with many files.
 *
 * @example
 * ```typescript
 * const visitor = new ASTVisitor();
 *
 * for (const sourceFile of program.getSourceFiles()) {
 *   if (!sourceFile.isDeclarationFile) {
 *     visitor.visit(sourceFile);
 *   }
 * }
 *
 * const results = visitor.getResults();
 * console.log('Found', results.builderConfigs.length, 'builder configs');
 * console.log('Parent containers:', Array.from(results.parentContainers));
 * ```
 */
export class ASTVisitor {
  private parentContainers = new Set<string>();
  private builderConfigs: ts.CallExpression[] = [];
  private partialConfigs: ts.CallExpression[] = [];
  private extendsReferences = new Set<string>();

  /**
   * Visits an AST node and collects all DI-related information.
   *
   * Recursively traverses the tree and identifies:
   * - defineBuilderConfig() calls
   * - definePartialConfig() calls
   * - useContainer property assignments (parent container references)
   * - extends array elements (partial config references)
   *
   * @param node - The AST node to visit
   *
   * @example
   * ```typescript
   * const visitor = new ASTVisitor();
   * visitor.visit(sourceFile);
   *
   * // The visitor now has collected all relevant information
   * const results = visitor.getResults();
   * ```
   */
  visit(node: ts.Node): void {
    // Handle call expressions (defineBuilderConfig, definePartialConfig)
    if (ts.isCallExpression(node)) {
      this.handleCallExpression(node);
    }

    // Handle property assignments (useContainer, extends)
    if (ts.isPropertyAssignment(node)) {
      this.handlePropertyAssignment(node);
    }

    // Recursively visit child nodes
    ts.forEachChild(node, (child) => this.visit(child));
  }

  /**
   * Handles call expressions to identify config definitions.
   *
   * Detects:
   * - `defineBuilderConfig({ ... })` - Main container definitions
   * - `definePartialConfig({ ... })` - Reusable partial configurations
   *
   * @param node - Call expression to analyze
   */
  private handleCallExpression(node: ts.CallExpression): void {
    const funcName = this.getFunctionName(node);

    if (funcName === 'defineBuilderConfig') {
      this.builderConfigs.push(node);
    } else if (funcName === 'definePartialConfig') {
      this.partialConfigs.push(node);
    }
  }

  /**
   * Handles property assignments to identify container relationships.
   *
   * Detects:
   * - `useContainer: parentContainer` - Parent container references
   * - `extends: [partial1, partial2]` - Partial config references
   *
   * @param node - Property assignment to analyze
   */
  private handlePropertyAssignment(node: ts.PropertyAssignment): void {
    if (!ts.isIdentifier(node.name)) return;

    const propertyName = node.name.text;

    // Detect: useContainer: someContainer
    if (propertyName === 'useContainer' && ts.isIdentifier(node.initializer)) {
      this.parentContainers.add(node.initializer.text);
    }

    // Detect: extends: [partial1, partial2, ...]
    if (propertyName === 'extends' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (ts.isIdentifier(element)) {
          this.extendsReferences.add(element.text);
        }
      }
    }
  }

  /**
   * Extracts the function name from a call expression.
   *
   * Handles direct identifiers (e.g., `defineBuilderConfig()`)
   * and returns undefined for complex expressions.
   *
   * @param node - Call expression to analyze
   * @returns Function name or undefined
   *
   * @example
   * ```typescript
   * defineBuilderConfig()      // Returns: 'defineBuilderConfig'
   * obj.method()               // Returns: undefined
   * ```
   */
  private getFunctionName(node: ts.CallExpression): string | undefined {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text;
    }
    return undefined;
  }

  /**
   * Returns all collected results from the AST traversal.
   *
   * @returns Object containing all discovered DI-related nodes and references
   *
   * @example
   * ```typescript
   * const results = visitor.getResults();
   *
   * // Access different collections:
   * results.builderConfigs.forEach(config => ...);
   * results.parentContainers.forEach(name => ...);
   * if (results.extendsReferences.has('sharedPartial')) { ... }
   * ```
   */
  getResults(): VisitorResults {
    return {
      parentContainers: this.parentContainers,
      builderConfigs: this.builderConfigs,
      partialConfigs: this.partialConfigs,
      extendsReferences: this.extendsReferences,
    };
  }

  /**
   * Resets all collected data.
   *
   * Useful when reusing the same visitor instance for multiple
   * independent traversals.
   *
   * @example
   * ```typescript
   * const visitor = new ASTVisitor();
   *
   * visitor.visit(sourceFile1);
   * const results1 = visitor.getResults();
   *
   * visitor.reset();
   * visitor.visit(sourceFile2);
   * const results2 = visitor.getResults();
   * ```
   */
  reset(): void {
    this.parentContainers.clear();
    this.builderConfigs = [];
    this.partialConfigs = [];
    this.extendsReferences.clear();
  }
}
