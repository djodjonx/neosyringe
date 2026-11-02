import {
  containerLookupFor,
  retentionEntries,
  toStableDiagnostic,
  type AnalysisError,
  type DependencyGraph,
  type DependencyNode,
} from '@djodjonx/neosyringe-core/analyzer';
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

/**
 * Serializes a graph. Its diagnostics are the config-level `graph.errors`.
 * One parameter on purpose: it is safe to pass as an `Array.map` callback.
 */
export function serializeGraph(graph: DependencyGraph): SerializableGraph {
  return serializeGraphWithErrors(graph, graph.errors);
}

/**
 * Serializes a graph with the analyzer errors that belong to this container (for example
 * the `extractAllErrors()` ones the caller attributed to it). They become its diagnostics,
 * in place of the config-level `graph.errors`. `undefined` means the graph has no diagnostics field.
 */
export function serializeGraphWithErrors(graph: DependencyGraph, errors: readonly AnalysisError[] | undefined): SerializableGraph {
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

  const diagnosticErrors = errors;
  const lookup = containerLookupFor(graph);

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
    // Causes come from the recorded retention. Nothing is recomputed and no node text is copied.
    ...(graph.retention !== undefined ? { retention: retentionEntries(graph) } : {}),
    ...(diagnosticErrors !== undefined ? { diagnostics: diagnosticErrors.map((error) => toStableDiagnostic(error, lookup)) } : {}),
  };
}
