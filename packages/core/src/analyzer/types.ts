import type { Symbol, Node } from 'typescript';

/**
 * Unique identifier for a token (interface name or class name).
 */
export type TokenId = string;

/**
 * How a service was registered in the container.
 * - `explicit`: Provider was explicitly specified.
 * - `autowire`: Token is both the token and provider (self-binding).
 * - `parent`: Inherited from parent container.
 * - `factory`: Provider is a factory function.
 */
export type RegistrationType = 'explicit' | 'autowire' | 'parent' | 'factory';

/**
 * Represents a single service definition in the dependency graph.
 */
export interface ServiceDefinition {
  /** Unique identifier for this service token. */
  tokenId: TokenId;

  /**
   * The TypeScript symbol of the concrete class implementation.
   * Undefined if the provider is a factory function.
   */
  implementationSymbol?: Symbol;

  /**
   * The TypeScript symbol of the token (if it is a Class/Value).
   * Undefined if the token is a virtual interface ID.
   */
  tokenSymbol?: Symbol;

  /** The source node where the registration happened (for error reporting). */
  registrationNode: Node;

  /** How this service was registered. */
  type: RegistrationType;

  /** Lifecycle of the service instance. */
  lifecycle: 'singleton' | 'transient';

  /** True if the token is an interface (requires string literal key). */
  isInterfaceToken?: boolean;

  /** True if the token is a value token for primitives. */
  isValueToken?: boolean;

  /** True if the provider is a factory function. */
  isFactory?: boolean;

  /** The raw source text of the factory function (for code generation). */
  factorySource?: string;

  /** True if this injection is scoped to the local container. */
  isScoped?: boolean;
}

/**
 * A node in the dependency graph representing a service and its dependencies.
 */
export interface DependencyNode {
  /** The service definition. */
  service: ServiceDefinition;

  /** Token IDs of dependencies required by this service's constructor. */
  dependencies: TokenId[];
}

/**
 * Complete dependency graph for a container configuration.
 */
export interface DependencyGraph {
  /** All service nodes indexed by their token ID. */
  nodes: Map<TokenId, DependencyNode>;

  /** Root services that are explicitly requested or exported. */
  roots: TokenId[];

  /** Arguments passed to the .build() method call (raw source text). */
  buildArguments?: string[];

  /** Optional container name for debugging. */
  containerName?: string;

  /** The exported variable name used for the container (e.g., 'appContainer'). */
  exportedVariableName?: string;

  /** Export modifier for the container variable: 'export', 'export default', or undefined (no export). */
  variableExportModifier?: 'export' | 'export default' | undefined;

  /** Start position of the variable statement containing defineBuilderConfig (where to insert generated code). */
  variableStatementStart?: number;

  /** Start position of the defineBuilderConfig expression in the source file. */
  defineBuilderConfigStart?: number;

  /** End position of the defineBuilderConfig expression in the source file. */
  defineBuilderConfigEnd?: number;

  /** Legacy container variable names to delegate to. */
  legacyContainers?: string[];

  /** Tokens provided by the parent container (used for validation). */
  parentProvidedTokens?: Set<TokenId>;

  /** Analysis errors collected during extraction (duplicates, type mismatches, etc.). */
  errors?: AnalysisError[];
}

/**
 * Type of analysis error.
 */
export type AnalysisErrorType = 'duplicate' | 'type-mismatch';

/**
 * An error detected during dependency graph analysis.
 */
export interface AnalysisError {
  /** Type of error. */
  type: AnalysisErrorType;

  /** Error message. */
  message: string;

  /** The AST node where the error occurred. */
  node: Node;

  /** The source file containing the error. */
  sourceFile: any; // ts.SourceFile but avoiding circular dependency
}
