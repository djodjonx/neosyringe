import {
  containerLookupFor,
  retentionEntries,
  toStableDiagnostic,
  type AnalysisError,
  type DependencyGraph,
  type DependencyNode,
} from '@djodjonx/neosyringe-core/analyzer';
import type { SerializableGraph, SerializableMultiRegistration, SerializableNode } from './types';

// The light entry (`@djodjonx/neosyringe-ui/serialize`): the two serializers and the types they return. No renderer.
export type {
  SerializableBorrowedRegistration,
  SerializableDiagnostic,
  SerializableGraph,
  SerializableMultiRegistration,
  SerializableNode,
  SerializableRetentionEntry,
} from './types';

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
 * The registration each alias ends at, by token: the local node its chain reaches, or `null` for a chain that ends at a
 * token a parent provides or runs in a cycle. Every chain is walked once, without recursion, and each link remembers its
 * answer, so a chain of any length costs one pass.
 */
function aliasOwners(graph: DependencyGraph): Map<string, DependencyNode | null> {
  const owners = new Map<string, DependencyNode | null>();
  for (const [start, first] of graph.nodes) {
    if (first.service.type !== 'alias' || owners.has(start)) continue;
    const path: string[] = [];
    const visiting = new Set<string>();
    let owner: DependencyNode | null = null;
    let current: string | undefined = start;
    while (current !== undefined) {
      const known = owners.get(current);
      if (known !== undefined) {
        owner = known;
        break;
      }
      const node = graph.nodes.get(current);
      if (node === undefined || visiting.has(current)) break;
      if (node.service.type !== 'alias') {
        owner = node;
        break;
      }
      visiting.add(current);
      path.push(current);
      current = node.service.aliasTarget?.tokenId;
    }
    for (const token of path) owners.set(token, owner);
  }
  return owners;
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
  const owners = aliasOwners(graph);

  for (const [tokenId, node] of graph.nodes) {
    // An alias owns nothing: it shows the lifecycle and the owner of the registration it ends at, and `singleton` and
    // `borrowed` when that is a token a parent provides (the same reading as the IR).
    const owned = node.service.type === 'alias' ? owners.get(tokenId) : undefined;
    const shown = owned?.service ?? node.service;
    const ownership = node.service.type === 'alias' && owned === null ? 'borrowed' : shown.ownership;
    nodes.push({
      tokenId,
      ...(node.service.registrationId !== undefined ? { registrationId: node.service.registrationId } : {}),
      ...(ownership !== undefined ? { ownership } : {}),
      lifecycle: node.service.type === 'alias' && owned === null ? 'singleton' : shown.lifecycle,
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
