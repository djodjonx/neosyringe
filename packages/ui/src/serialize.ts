import type { DependencyGraph } from '@djodjonx/neosyringe-core/analyzer';
import type { SerializableGraph, SerializableNode } from './types';

export function serializeGraph(graph: DependencyGraph): SerializableGraph {
  const nodes: SerializableNode[] = [];

  for (const [tokenId, node] of graph.nodes) {
    nodes.push({
      tokenId,
      lifecycle: node.service.lifecycle,
      type: node.service.type,
      dependencies: node.dependencies,
      optionalDependencies: node.optionalDependencies
        ? [...node.optionalDependencies]
        : [],
    });
  }

  return {
    containerId: graph.containerId,
    containerName: graph.containerName,
    nodes,
    roots: graph.roots,
  };
}
