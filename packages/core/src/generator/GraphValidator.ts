import type { Node, SourceFile } from 'typescript';
import { DependencyGraph, TokenId } from '../analyzer/types';

/**
 * Extracts the simple name from a token ID (removes the hash suffix).
 * Examples:
 * - "IEventBus_714d1af6" -> "IEventBus"
 * - "useInterface<ILogger>()" -> "ILogger"
 * - "UserService" -> "UserService"
 */
function getSimpleName(tokenId: TokenId): string {
  // Handle useInterface<X>() format
  const interfaceMatch = tokenId.match(/useInterface<([^>]+)>/);
  if (interfaceMatch) {
    const innerName = interfaceMatch[1];
    // Remove hash if present
    return innerName.split('_')[0];
  }

  // Handle Name_hash format
  const parts = tokenId.split('_');
  if (parts.length > 1) {
    // Check if last part looks like a hash (alphanumeric, 6-12 chars)
    const lastPart = parts[parts.length - 1];
    if (/^[a-f0-9]{6,12}$/i.test(lastPart)) {
      return parts.slice(0, -1).join('_');
    }
  }

  return tokenId;
}

/**
 * Represents a validation error found in the dependency graph.
 */
export interface GraphValidationError {
  /** Type of validation error */
  type: 'missing' | 'duplicate' | 'cycle';
  /** Human-readable error message */
  message: string;
  /** The AST node where the error occurred (for positioning in IDE) */
  node: Node;
  /** The source file containing the error */
  sourceFile: SourceFile;
  /** The token/service that has the error */
  tokenId: TokenId;
  /** The missing dependency (for 'missing' type) */
  dependencyId?: TokenId;
}

/**
 * Result of graph validation.
 */
export interface GraphValidationResult {
  /** Whether the graph is valid (no errors) */
  valid: boolean;
  /** List of all validation errors found */
  errors: GraphValidationError[];
}

/**
 * Validates the dependency graph for correctness.
 * Detects circular dependencies, missing bindings, and duplicates.
 */
export class GraphValidator {
  /**
   * Validates the graph structure and returns all errors found.
   * Does not throw - collects all errors for display.
   *
   * @param graph - The dependency graph to validate.
   * @returns Validation result with all errors.
   */
  public validateAll(graph: DependencyGraph): GraphValidationResult {
    const errors: GraphValidationError[] = [];
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
        errors.push({
          type: 'duplicate',
          message: `Duplicate registration: '${getSimpleName(nodeId)}' is already registered in the parent container. Use 'scoped: true' to override.`,
          node: node.service.registrationNode,
          sourceFile: node.service.registrationNode.getSourceFile(),
          tokenId: nodeId,
        });
      }
    }

    // 2. Check for Missing Dependencies
    for (const [nodeId, node] of graph.nodes) {
      for (const depId of node.dependencies) {
        // Check if dependency is provided locally OR by parent
        const isProvidedLocally = graph.nodes.has(depId);
        const isProvidedByParent = parentTokens.has(depId);

        if (!isProvidedLocally && !isProvidedByParent) {
          errors.push({
            type: 'missing',
            message: `Missing binding: Service '${getSimpleName(nodeId)}' depends on '${getSimpleName(depId)}', but no provider was registered.`,
            node: node.service.registrationNode,
            sourceFile: node.service.registrationNode.getSourceFile(),
            tokenId: nodeId,
            dependencyId: depId,
          });
        }
      }
    }

    // 3. Check for Cycles (only in local nodes, parent is assumed valid)
    for (const nodeId of graph.nodes.keys()) {
      if (!visited.has(nodeId)) {
        this.detectCycleCollect(nodeId, graph, visited, recursionStack, parentTokens, errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates the graph structure.
   * @deprecated Use validateAll() instead for complete error reporting.
   *
   * @param graph - The dependency graph to validate.
   * @throws {Error} If a circular dependency or missing binding is detected.
   */
  public validate(graph: DependencyGraph): void {
    const result = this.validateAll(graph);
    if (!result.valid && result.errors.length > 0) {
      // Throw the first error for backward compatibility
      throw new Error(result.errors[0].message);
    }
  }

  /**
   * Recursive Helper for Cycle Detection that collects errors.
   */
  private detectCycleCollect(
    nodeId: TokenId,
    graph: DependencyGraph,
    visited: Set<TokenId>,
    stack: Set<TokenId>,
    parentTokens: Set<TokenId>,
    errors: GraphValidationError[]
  ): void {
    visited.add(nodeId);
    stack.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        // Skip parent-provided tokens (they're external, no cycle possible with local graph)
        if (parentTokens.has(depId)) continue;

        if (!visited.has(depId)) {
          this.detectCycleCollect(depId, graph, visited, stack, parentTokens, errors);
        } else if (stack.has(depId)) {
          const cycle = [...stack, depId];
          const readableCycle = cycle.map(id => getSimpleName(id));
          errors.push({
            type: 'cycle',
            message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
            node: node.service.registrationNode,
            sourceFile: node.service.registrationNode.getSourceFile(),
            tokenId: nodeId,
          });
        }
      }
    }

    stack.delete(nodeId);
  }

  /**
   * @deprecated Use detectCycleCollect instead
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
