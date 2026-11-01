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
  /** Identity of this config. Never the container name. */
  containerKey?: string;
  nodes: SerializableNode[];
  roots: string[];
  /** Multi-registrations, map order then registration order. */
  multiNodes?: SerializableMultiRegistration[];
  /** Parent registrations borrowed by this container. `containerId` is the parent containerKey. */
  borrowedRegistrations?: SerializableBorrowedRegistration[];
}

export interface SerializableMultiRegistration {
  /** Omitted when the registration has no id. */
  registrationId?: string;
  tokenId: string;
  lifecycle: 'singleton' | 'transient';
  type: 'explicit' | 'autowire' | 'parent' | 'factory' | 'value';
  dependencies: string[];
  optionalDependencies: string[];
}

export interface SerializableBorrowedRegistration {
  registrationId: string;
  tokenId: string;
  containerId: string;
}

/**
 * JSON-serializable subset of DependencyNode.
 */
export interface SerializableNode {
  tokenId: string;
  /** Present when the registration stamped an id. */
  registrationId?: string;
  /** `owned` or `borrowed`, when the analyzer set it. */
  ownership?: 'owned' | 'borrowed';
  lifecycle: 'singleton' | 'transient';
  type: 'explicit' | 'autowire' | 'parent' | 'factory' | 'value';
  dependencies: string[];
  optionalDependencies: string[];
}
