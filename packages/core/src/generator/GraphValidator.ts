import { DependencyGraph, TokenId } from '../analyzer/types';

/**
 * Validates the dependency graph for correctness.
 * Detects circular dependencies, missing bindings, and duplicates.
 */
export class GraphValidator {
  /**
   * Validates the graph structure.
   *
   * @param graph - The dependency graph to validate.
   * @throws {Error} If a circular dependency or missing binding is detected.
   */
  public validate(graph: DependencyGraph): void {
    const visited = new Set<TokenId>();
    const recursionStack = new Set<TokenId>();

    // Get tokens provided by parent container (if any)
    const parentTokens = graph.parentProvidedTokens ?? new Set<TokenId>();

    // 1. Check for Duplicate Registrations (local token already in parent)
    for (const [nodeId, node] of graph.nodes) {
        if (parentTokens.has(nodeId)) {
            // Allow if scoped: true (intentional override)
            if (node.service.isScoped) {
                continue;
            }
            throw new Error(
                `Duplicate registration: '${nodeId}' is already registered in the parent container. ` +
                `Use 'scoped: true' to override the parent's registration intentionally.`
            );
        }
    }

    // 2. Check for Missing Dependencies
    for (const [nodeId, node] of graph.nodes) {
        for (const depId of node.dependencies) {
            // Check if dependency is provided locally OR by parent
            const isProvidedLocally = graph.nodes.has(depId);
            const isProvidedByParent = parentTokens.has(depId);

            if (!isProvidedLocally && !isProvidedByParent) {
                const serviceName = nodeId;
                throw new Error(
                    `Missing binding: Service '${serviceName}' depends on '${depId}', but no provider was registered.`
                );
            }
        }
    }

    // 3. Check for Cycles (only in local nodes, parent is assumed valid)
    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        this.detectCycle(nodeId, graph, visited, recursionStack, parentTokens);
      }
    }
  }

  /**
   * Recursive Helper for Cycle Detection (DFS).
   *
   * @param nodeId - The current node ID.
   * @param graph - The graph.
   * @param visited - Set of all visited nodes.
   * @param stack - Set of nodes in the current recursion stack (path).
   * @param parentTokens - Tokens from parent container (skip traversal).
   */
  private detectCycle(
    nodeId: TokenId,
    graph: DependencyGraph,
    visited: Set<TokenId>,
    stack: Set<TokenId>,
    parentTokens: Set<TokenId>
  ): void {
    visited.add(nodeId);
    stack.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        // Skip parent-provided tokens (they're external, no cycle possible with local graph)
        if (parentTokens.has(depId)) continue;

        if (!visited.has(depId)) {
          this.detectCycle(depId, graph, visited, stack, parentTokens);
        } else if (stack.has(depId)) {
          throw new Error(`Circular dependency detected: ${[...stack, depId].join(' -> ')}`);
        }
      }
    }

    stack.delete(nodeId);
  }
}
