import * as ts from 'typescript';
import type { DependencyGraph } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';
import { CallExpressionUtils } from '../utils/CallExpressionUtils';

/**
 * Resolves parent container tokens and manages container hierarchy.
 *
 * This service handles the extraction of tokens from parent containers,
 * supporting both:
 * - NeoSyringe containers (defineBuilderConfig/definePartialConfig)
 * - Legacy containers (declareContainerTokens)
 *
 * It also handles transitive parent token inheritance (parent's parent tokens).
 *
 * @example
 * ```typescript
 * const resolver = new ParentContainerResolver(checker, tokenResolverService, parseCallback);
 *
 * const graph: DependencyGraph = { ... };
 * resolver.extractParentContainerTokens(containerIdentifier, graph);
 *
 * // graph.parentProvidedTokens now contains all tokens from the parent
 * ```
 */
export class ParentContainerResolver {
  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService,
    private parseBuilderConfigCallback: (node: ts.CallExpression, graph: DependencyGraph) => void
  ) {}

  /**
   * Extracts tokens provided by a parent container.
   *
   * Handles:
   * 1. NeoSyringe containers (defineBuilderConfig/definePartialConfig)
   * 2. Legacy containers (declareContainerTokens)
   * 3. Transitive parent tokens (parent's parent)
   *
   * @param containerIdentifier - Identifier of the parent container
   * @param graph - The dependency graph to populate with parent tokens
   * @param parentContainerNames - Set to mark this container as a parent
   *
   * @example
   * ```typescript
   * const identifier = ...; // reference to parent container
   * resolver.extractParentContainerTokens(identifier, graph, parentContainerNames);
   * // graph.parentProvidedTokens now contains parent's tokens
   * ```
   */
  extractParentContainerTokens(
    containerIdentifier: ts.Identifier,
    graph: DependencyGraph,
    parentContainerNames: Set<string>
  ): void {
    const symbol = this.checker.getSymbolAtLocation(containerIdentifier);
    if (!symbol) return;

    // Mark this container as a parent
    parentContainerNames.add(containerIdentifier.text);

    const resolvedSymbol = this.resolveSymbol(symbol);
    const declaration = resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0];
    if (!declaration) return;

    // Case 1: NeoSyringe container (defineBuilderConfig or definePartialConfig)
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const init = declaration.initializer;

      if (ts.isCallExpression(init)) {
        // Check if it's a NeoSyringe config call
        if (CallExpressionUtils.isDefineBuilderConfig(init) ||
            CallExpressionUtils.isDefinePartialConfig(init)) {
          this.extractFromNeoSyringeContainer(init, containerIdentifier.text, graph);
          return;
        }

        // Check if it's declareContainerTokens<{...}>()
        if (CallExpressionUtils.isDeclareContainerTokens(init)) {
          this.extractFromDeclaredTokens(init, graph);
          return;
        }
      }
    }
  }

  /**
   * Extracts tokens from a NeoSyringe container (defineBuilderConfig/definePartialConfig).
   *
   * Creates a temporary graph to parse the parent config, then extracts all tokens
   * including transitive parent tokens.
   *
   * @param init - The defineBuilderConfig/definePartialConfig call expression
   * @param containerName - Name of the parent container
   * @param graph - The child graph to populate with parent tokens
   */
  private extractFromNeoSyringeContainer(
    init: ts.CallExpression,
    containerName: string,
    graph: DependencyGraph
  ): void {
    // Parse the parent config to extract its tokens
    const parentGraph: DependencyGraph = {
      containerId: containerName,
      nodes: new Map(),
      roots: []
    };

    // Use callback to parse (avoids circular dependency)
    this.parseBuilderConfigCallback(init, parentGraph);

    // Add all parent tokens to parentProvidedTokens
    for (const tokenId of parentGraph.nodes.keys()) {
      graph.parentProvidedTokens!.add(tokenId);
    }

    // Also inherit parent's parent tokens (transitive inheritance)
    if (parentGraph.parentProvidedTokens) {
      for (const tokenId of parentGraph.parentProvidedTokens) {
        graph.parentProvidedTokens!.add(tokenId);
      }
    }
  }

  /**
   * Extracts tokens from declareContainerTokens<{ Token: Type }>().
   *
   * The type argument contains token declarations for a legacy container.
   * Each property in the type object represents a token.
   *
   * @param node - The declareContainerTokens call expression
   * @param graph - The graph to populate with declared tokens
   *
   * @example
   * ```typescript
   * // Given: declareContainerTokens<{ ILogger: ILogger, IDatabase: IDatabase }>()
   * // Extracts: ["ILogger_hash", "IDatabase_hash"]
   * ```
   */
  private extractFromDeclaredTokens(node: ts.CallExpression, graph: DependencyGraph): void {
    if (!node.typeArguments || node.typeArguments.length === 0) return;

    const typeArg = node.typeArguments[0];
    const type = this.checker.getTypeFromTypeNode(typeArg);

    // Get properties of the type (e.g., { AuthService: AuthService, UserRepo: UserRepo })
    const properties = type.getProperties();
    for (const prop of properties) {
      const propType = this.checker.getTypeOfSymbol(prop);
      if (propType) {
        const tokenId = this.tokenResolverService.getTypeId(propType);
        graph.parentProvidedTokens!.add(tokenId);
      } else {
        // Fallback to property name if type not available
        graph.parentProvidedTokens!.add(prop.getName());
      }
    }
  }

  /**
   * Resolves a symbol, following aliases if necessary.
   *
   * @param symbol - The symbol to resolve
   * @returns The resolved symbol (follows import aliases)
   */
  private resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      return this.resolveSymbol(this.checker.getAliasedSymbol(symbol));
    }
    return symbol;
  }
}
