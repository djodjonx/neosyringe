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
  /** Why each registration is kept, read from the analyzer. Absent when the graph recorded none. Causes and paths only: no size. */
  retention?: SerializableRetentionEntry[];
  /** The stable diagnostics of this container. Same `code` and `severity` as the CLI JSON and the LSP. */
  diagnostics?: SerializableDiagnostic[];
}

export interface SerializableRetentionEntry {
  registrationId: string;
  token: string;
  /** `root`, `eager`, `dependency-of`, `multi-contribution-of`, `open-parent`, `opaque-boundary` or `unreachable`. */
  cause: string;
  /** Simple names, root first. Empty when unreachable. */
  path: string[];
}

export interface SerializableDiagnostic {
  /** Stable machine contract. Absent only for errors that have no code yet. */
  code?: string;
  severity: 'error' | 'warning';
  message: string;
  file: string;
  line: number;
  column: number;
  type: string;
  containerId?: string;
  /** Name of the container `containerId` points to. */
  containerName?: string;
  /** Source file of that container. */
  containerFile?: string;
  token?: string;
  chain?: string[];
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
