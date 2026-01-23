import * as ts from 'typescript';
import type { DependencyGraph, DependencyNode, TokenId } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';

/**
 * Service for resolving dependencies of services by analyzing constructors.
 *
 * This service extracts constructor parameters and maps them to their corresponding
 * token IDs in the dependency graph. It handles:
 * - Property tokens (primitives bound to specific constructor parameters)
 * - Interface tokens (from useInterface calls)
 * - Class tokens (direct class references)
 *
 * @example
 * ```typescript
 * const resolver = new DependencyResolver(checker, tokenResolverService);
 *
 * // Resolve all dependencies in a graph
 * resolver.resolveAll(graph);
 *
 * // Resolve dependencies for a single node
 * resolver.resolve(node, graph);
 * ```
 */
export class DependencyResolver {
  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService
  ) {}

  /**
   * Resolves dependencies for all nodes in the dependency graph.
   *
   * Iterates through all service nodes and analyzes their constructors
   * to determine what dependencies they require.
   *
   * @param graph - The dependency graph to process
   *
   * @example
   * ```typescript
   * const graph: DependencyGraph = {
   *   nodes: new Map([
   *     ['UserService', { service: userServiceDef, dependencies: [] }],
   *     ['ILogger', { service: loggerDef, dependencies: [] }]
   *   ]),
   *   // ...
   * };
   *
   * resolver.resolveAll(graph);
   * // Now: graph.nodes.get('UserService').dependencies = ['ILogger']
   * ```
   */
  resolveAll(graph: DependencyGraph): void {
    for (const node of graph.nodes.values()) {
      this.resolve(node, graph);
    }
  }

  /**
   * Resolves dependencies for a single service node.
   *
   * Analyzes the constructor of the service's implementation class and:
   * 1. Checks for property tokens (e.g., useProperty<string>(MyClass, 'configPath'))
   * 2. Falls back to type-based resolution for class/interface dependencies
   * 3. Skips factory providers (they handle their own dependencies)
   *
   * @param node - The dependency node to analyze
   * @param graph - The complete dependency graph (for property token lookup)
   *
   * @example
   * ```typescript
   * // Given this service:
   * class UserService {
   *   constructor(
   *     private logger: ILogger,           // Resolves to 'ILogger_abc123'
   *     private apiUrl: string             // Resolves to property token if registered
   *   ) {}
   * }
   *
   * resolver.resolve(userServiceNode, graph);
   * // userServiceNode.dependencies = ['ILogger_abc123', 'PropertyToken:UserService.apiUrl']
   * ```
   */
  resolve(node: DependencyNode, graph: DependencyGraph): void {
    // Factories handle their own dependencies via container.resolve()
    // We don't need to analyze them statically
    if (node.service.isFactory || node.service.type === 'factory') {
      return;
    }

    const symbol = node.service.implementationSymbol;
    if (!symbol) return;

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return;

    const classDecl = declarations.find((d) => ts.isClassDeclaration(d)) as
      | ts.ClassDeclaration
      | undefined;
    if (!classDecl) return;

    const className = classDecl.name?.getText() ?? 'Anonymous';

    // Find constructor
    const constructor = classDecl.members.find((m) =>
      ts.isConstructorDeclaration(m)
    ) as ts.ConstructorDeclaration | undefined;

    if (!constructor) {
      // No constructor or default constructor (no dependencies)
      return;
    }

    // Analyze each constructor parameter
    for (const param of constructor.parameters) {
      const dependency = this.resolveParameter(param, className, graph);
      if (dependency) {
        node.dependencies.push(dependency);
      }
    }
  }

  /**
   * Resolves a single constructor parameter to its token ID.
   *
   * Resolution strategy:
   * 1. Check if a PropertyToken exists for this class.parameter
   * 2. If not, resolve by parameter type (class or interface)
   * 3. Skip parameters without type annotations
   *
   * @param param - Constructor parameter to resolve
   * @param className - Name of the class containing the constructor
   * @param graph - Dependency graph to check for property tokens
   * @returns Token ID or undefined if not resolvable
   *
   * @example
   * ```typescript
   * // Parameter with property token:
   * constructor(private apiUrl: string) {}
   * // If property token exists: returns 'PropertyToken:MyClass.apiUrl'
   *
   * // Parameter with class type:
   * constructor(private logger: ILogger) {}
   * // Returns: 'ILogger_abc123'
   *
   * // Parameter without type annotation:
   * constructor(private value) {}
   * // Returns: undefined (cannot inject safely)
   * ```
   */
  private resolveParameter(
    param: ts.ParameterDeclaration,
    className: string,
    graph: DependencyGraph
  ): TokenId | undefined {
    const paramName = param.name.getText();
    const typeNode = param.type;

    if (!typeNode) {
      // Without type annotation, we can't safely inject
      // This could be implicit 'any' or inferred type
      return undefined;
    }

    // 1. Check if there's a PropertyToken for this class.parameter
    // Property tokens are used for primitives (string, number, etc.)
    const propertyTokenId = `PropertyToken:${className}.${paramName}`;
    if (graph.nodes.has(propertyTokenId)) {
      return propertyTokenId;
    }

    // 2. Fallback: resolve by type (class/interface)
    const type = this.checker.getTypeFromTypeNode(typeNode);
    return this.tokenResolverService.getTypeId(type);
  }
}
