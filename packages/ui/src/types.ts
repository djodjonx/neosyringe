/**
 * JSON-serializable subset of DependencyGraph — strips all TypeScript AST references.
 */
export interface SerializableGraph {
  containerId: string;
  containerName?: string;
  /** Variable name from source code — most readable identifier (e.g. `appContainer`). */
  exportedVariableName?: string;
  /** Absolute path of the source file containing the container definition. */
  sourceFileName?: string;
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
