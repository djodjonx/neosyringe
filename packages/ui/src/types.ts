/**
 * JSON-serializable subset of DependencyGraph — strips all TypeScript AST references.
 */
export interface SerializableGraph {
  containerId: string;
  containerName?: string;
  nodes: SerializableNode[];
  roots: string[];
}

/**
 * JSON-serializable subset of DependencyNode.
 */
export interface SerializableNode {
  tokenId: string;
  lifecycle: 'singleton' | 'transient';
  type: 'explicit' | 'autowire' | 'parent' | 'factory' | 'value';
  dependencies: string[];
  optionalDependencies: string[];
}
