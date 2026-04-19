import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { TokenId, ServiceDefinition } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';

/**
 * Analyzes class constructors and factory functions to extract required dependencies.
 */
export class DependencyAnalyzer {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly tokenResolverService: TokenResolverService
  ) {}

  /**
   * Extracts all dependencies required by a service definition.
   * @param definition - Service definition to analyze
   * @returns Array of token IDs required by this service
   */
  getRequiredDependencies(definition: ServiceDefinition): TokenId[] {
    // Factories handle their own dependencies via container.resolve()
    if (definition.type === 'factory') {
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

    const classDecl = declarations.find(d => TSContext.ts.isClassDeclaration(d)) as ts.ClassDeclaration | undefined;
    if (!classDecl) return dependencies;

    const constructor = classDecl.members.find(
      m => TSContext.ts.isConstructorDeclaration(m)
    ) as ts.ConstructorDeclaration | undefined;

    if (!constructor) return dependencies;

    for (const param of constructor.parameters) {
      const typeNode = param.type;
      if (!typeNode) continue; // No type annotation — cannot determine dependency

      const type = this.checker.getTypeFromTypeNode(typeNode);
      dependencies.push(this.tokenResolverService.getHashedTokenIdFromType(type));
    }

    return dependencies;
  }
}
