import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { DependencyGraph, DependencyNode } from '../types';
import { declaredFactoryEdges, resolveConstructorSignature } from '../shared/registrationGraph';
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
    if (!graph.multiNodes) return;
    for (const nodes of graph.multiNodes.values()) {
      for (const node of nodes) {
        if (node.service.type === 'factory') this.applyFactoryEdges(node);
      }
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
    // Values are constants with no constructor to analyze
    if (node.service.type === 'factory') {
      this.applyFactoryEdges(node);
      return;
    }
    if (node.service.type === 'value') {
      return;
    }

    const symbol = node.service.implementationSymbol;
    if (!symbol) return;

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return;

    const classDecl = declarations.find((d) => TSContext.ts.isClassDeclaration(d)) as
      | ts.ClassDeclaration
      | undefined;
    if (!classDecl) return;

    const knownTokenIds = new Set(graph.nodes.keys());
    if (graph.parentProvidedTokens) {
      for (const tokenId of graph.parentProvidedTokens) knownTokenIds.add(tokenId);
    }
    const signature = resolveConstructorSignature(
      this.checker,
      this.tokenResolverService,
      classDecl,
      knownTokenIds,
    );
    const multiIds = new Set(graph.multiNodes?.keys() ?? []);
    for (const edge of signature.edges) {
      edge.multi = multiIds.has(edge.tokenId);
    }
    node.service.dependencyEdges = signature.edges;
    for (const edge of signature.edges) {
      node.dependencies.push(edge.tokenId);
      if (edge.optional) {
        node.optionalDependencies ??= new Set();
        node.optionalDependencies.add(edge.tokenId);
      }
    }
    if (signature.diagnostics.length === 0) return;
    if (!graph.errors) graph.errors = [];
    const sourceFile = classDecl.getSourceFile();
    for (const diagnostic of signature.diagnostics) {
      graph.errors.push({
        type: 'unsupported',
        code: diagnostic.code,
        message: diagnostic.message,
        node: classDecl,
        sourceFile,
      });
    }
  }

  private applyFactoryEdges(node: DependencyNode): void {
    node.dependencies = declaredFactoryEdges(node.service);
  }
}
