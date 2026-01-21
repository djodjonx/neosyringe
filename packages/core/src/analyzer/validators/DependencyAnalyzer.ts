import * as ts from 'typescript';
import type { TokenId, ServiceDefinition } from '../types';
import { generateTokenId } from '../Analyzer';

/**
 * Analyzes class constructors and factory functions to extract required dependencies.
 */
export class DependencyAnalyzer {
  constructor(private readonly checker: ts.TypeChecker) {}

  /**
   * Extracts all dependencies required by a service definition.
   * @param definition - Service definition to analyze
   * @returns Array of token IDs required by this service
   */
  getRequiredDependencies(definition: ServiceDefinition): TokenId[] {
    // Factories handle their own dependencies via container.resolve()
    if (definition.isFactory || definition.type === 'factory') {
      return [];
    }

    // No implementation symbol means no dependencies to analyze
    if (!definition.implementationSymbol) {
      return [];
    }

    return this.getConstructorDependencies(definition.implementationSymbol);
  }

  /**
   * Extracts dependencies from a class constructor.
   * @param symbol - Class symbol to analyze
   * @returns Array of token IDs required by the constructor
   */
  private getConstructorDependencies(symbol: ts.Symbol): TokenId[] {
    const dependencies: TokenId[] = [];

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return dependencies;

    const classDecl = declarations.find(d => ts.isClassDeclaration(d)) as ts.ClassDeclaration | undefined;
    if (!classDecl) return dependencies;

    const className = classDecl.name?.getText() ?? 'Anonymous';

    // Find constructor
    const constructor = classDecl.members.find(
      m => ts.isConstructorDeclaration(m)
    ) as ts.ConstructorDeclaration | undefined;

    if (!constructor) return dependencies; // No constructor or default constructor

    for (const param of constructor.parameters) {
      const paramName = param.name.getText();
      const typeNode = param.type;

      if (!typeNode) {
        // No type annotation - can't safely determine dependency
        continue;
      }

      const type = this.checker.getTypeFromTypeNode(typeNode);

      // Try to get a meaningful token ID for this dependency
      const depTokenId = this.getTypeId(type, className, paramName);
      dependencies.push(depTokenId);
    }

    return dependencies;
  }

  /**
   * Generates a unique Token ID for a given Type.
   * Uses symbol name and file path hash for consistency.
   *
   * @param type - The TypeScript Type
   * @param _className - Parent class name (for property tokens) - reserved for future use
   * @param _paramName - Parameter name (for property tokens) - reserved for future use
   * @returns A string identifier for the token
   */
  private getTypeId(type: ts.Type, _className?: string, _paramName?: string): TokenId {
    const symbol = type.getSymbol();
    if (!symbol) {
      return this.checker.typeToString(type);
    }

    const name = symbol.getName();

    // Guard against internal property names
    if (name === '__type' || name === 'InterfaceToken' || name === '__brand') {
      return this.checker.typeToString(type);
    }

    // Use the same ID generation logic as the Analyzer
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const sourceFile = declarations[0].getSourceFile();
      return generateTokenId(symbol, sourceFile);
    }

    // Fallback to symbol name
    return name;
  }
}
