import type { DependencyGraph, DependencyNode } from '@djodjonx/neosyringe-core/analyzer';
import type { SerializableGraph, SerializableMultiRegistration, SerializableNode } from './types';

function serializeMulti(multiNodes: Map<string, DependencyNode[]>): SerializableMultiRegistration[] {
  const serialized: SerializableMultiRegistration[] = [];
  for (const registrations of multiNodes.values()) {
    for (const node of registrations) {
      serialized.push({
        ...(node.service.registrationId !== undefined ? { registrationId: node.service.registrationId } : {}),
        tokenId: node.service.tokenId,
        lifecycle: node.service.lifecycle,
        type: node.service.type,
        dependencies: node.dependencies,
        optionalDependencies: node.optionalDependencies ? [...node.optionalDependencies] : [],
      });
    }
  }
  return serialized;
}

export function serializeGraph(graph: DependencyGraph): SerializableGraph {
  const nodes: SerializableNode[] = [];

  for (const [tokenId, node] of graph.nodes) {
    nodes.push({
      tokenId,
      ...(node.service.registrationId !== undefined ? { registrationId: node.service.registrationId } : {}),
      ...(node.service.ownership !== undefined ? { ownership: node.service.ownership } : {}),
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
    exportedVariableName: graph.exportedVariableName,
    sourceFileName: graph.sourceFileName,
    ...(graph.containerKey !== undefined ? { containerKey: graph.containerKey } : {}),
    nodes,
    roots: graph.roots,
    ...(graph.multiNodes !== undefined ? { multiNodes: serializeMulti(graph.multiNodes) } : {}),
    ...(graph.borrowedRegistrations !== undefined ? {
      borrowedRegistrations: graph.borrowedRegistrations.map((registration) => ({
        registrationId: registration.registrationId,
        tokenId: registration.tokenId,
        containerId: registration.containerId,
      })),
    } : {}),
  };
}
