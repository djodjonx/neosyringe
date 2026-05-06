import type { DependencyNode, TokenId } from '../analyzer/types';

/**
 * Sorts service tokens in dependency order (dependencies before dependents).
 * Uses iterative depth-first search.
 * @throws Error if a cycle is detected — validate the graph before calling.
 */
export function topologicalSort(nodes: Map<TokenId, DependencyNode>): TokenId[] {
  const visited = new Set<TokenId>();
  const sorted: TokenId[] = [];

  for (const startId of nodes.keys()) {
    if (visited.has(startId)) continue;

    // Each stack frame: [id, dependencies iterator]
    const iterStack: Array<[TokenId, Iterator<TokenId>]> = [];
    const recursionSet = new Set<TokenId>();

    iterStack.push([startId, (nodes.get(startId)?.dependencies ?? [])[Symbol.iterator]()]);
    recursionSet.add(startId);

    while (iterStack.length > 0) {
      const frame = iterStack[iterStack.length - 1];
      const [id, depsIter] = frame;

      const next = depsIter.next();
      if (!next.done) {
        const depId = next.value;
        if (visited.has(depId)) continue;
        if (recursionSet.has(depId)) {
          throw new Error(
            `[Generator] Cycle detected involving '${depId}'. Validate the graph before calling generate().`
          );
        }
        iterStack.push([depId, (nodes.get(depId)?.dependencies ?? [])[Symbol.iterator]()]);
        recursionSet.add(depId);
      } else {
        // All deps processed — emit this node
        iterStack.pop();
        recursionSet.delete(id);
        if (!visited.has(id)) {
          visited.add(id);
          if (nodes.has(id)) sorted.push(id);
        }
      }
    }
  }

  return sorted;
}
