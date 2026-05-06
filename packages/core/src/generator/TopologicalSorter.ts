import type { DependencyNode, TokenId } from '../analyzer/types';

/**
 * Sorts service tokens in dependency order (dependencies before dependents).
 * Uses recursive depth-first search.
 * @throws Error if a cycle is detected — validate the graph before calling.
 */
export function topologicalSort(nodes: Map<TokenId, DependencyNode>): TokenId[] {
  const visited = new Set<TokenId>();
  const stack = new Set<TokenId>();
  const sorted: TokenId[] = [];

  const visit = (id: TokenId) => {
    if (visited.has(id)) return;
    if (stack.has(id)) {
      throw new Error(
        `[Generator] Cycle detected involving '${id}'. Validate the graph before calling generate().`
      );
    }
    stack.add(id);
    const node = nodes.get(id);
    if (node) {
      for (const depId of node.dependencies) {
        visit(depId);
      }
      sorted.push(id);
    }
    stack.delete(id);
    visited.add(id);
  };

  for (const id of nodes.keys()) {
    visit(id);
  }

  return sorted;
}
