import type { Symbol, Node, SourceFile, CallExpression } from 'typescript';

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

// ============================================================================
// CONFIG GRAPH TYPES (for modular validation)
// ============================================================================

/**
 * Type of container configuration.
 */
export type ConfigType = 'builder' | 'partial';

/**
 * Represents a collected configuration (defineBuilderConfig or definePartialConfig).
 */
export interface ConfigGraph {
  /** Variable name (appContainer, sharedPartial) */
  name: string;

  /** Configuration type */
  type: ConfigType;

  /** Source file containing this config */
  sourceFile: SourceFile;

  /** AST node of the call expression */
  node: CallExpression;

  /** Local injections (tokenId -> info) */
  localInjections: Map<TokenId, InjectionInfo>;

  /** Duplicate injections detected during collection (for error reporting) */
  duplicates: InjectionInfo[];

  /** Extended partial names - BUILDER ONLY */
  extendsRefs: string[];

  /** Parent container reference - BUILDER ONLY */
  useContainerRef: string | null;

  /** Tokens provided by legacy parent containers (declareContainerTokens) - BUILDER ONLY */
  legacyParentTokens?: Set<TokenId>;

  /** Container name from config */
  containerName?: string;
}

/**
 * Information about a single injection.
 */
export interface InjectionInfo {
  /** Service definition */
  definition: ServiceDefinition;

  /** AST node for error positioning */
  node: Node;

  /** Token text for error messages */
  tokenText: string;

  /** Is this a scoped override? */
  isScoped: boolean;
}

// ============================================================================
// INHERITED TOKEN TYPES
// ============================================================================

/**
 * A token inherited from parent or extends.
 */
export interface InheritedToken {
  /** Token ID */
  tokenId: TokenId;

  /** Source of inheritance */
  source: TokenSource;

  /** Token text for error messages */
  tokenText: string;
}

/**
 * Source of an inherited token.
 */
export interface TokenSource {
  /** Source config name */
  name: string;

  /** Type of source */
  type: 'parent' | 'extends';

  /** Full chain for deep inheritance */
  chain?: string[];
}

// ============================================================================
// DEPENDENCY GRAPH (legacy, for code generation)
// ============================================================================

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

  /** Export modifier for the container variable: 'export', 'export default', 'none', or undefined (defaults to 'export'). */
  variableExportModifier?: 'export' | 'export default' | 'none';

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

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Type of analysis error.
 */
export type AnalysisErrorType = 'duplicate' | 'type-mismatch' | 'cycle' | 'missing';

/**
 * Context for error messages.
 */
export interface ErrorContext {
  /** Token text */
  tokenText?: string;

  /** Conflict source name */
  conflictSource?: string;

  /** Dependency chain (for cycles) */
  chain?: string[];
}

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
  sourceFile: SourceFile;

  /** Additional context for the message. */
  context?: ErrorContext;
}

// ============================================================================
// ANALYSIS RESULT
// ============================================================================

/**
 * Result of analyzing a file or program.
 */
export interface AnalysisResult {
  /** All configs collected */
  configs: Map<string, ConfigGraph>;

  /** Detected errors */
  errors: AnalysisError[];

  /** Primary graph for code generation */
  primaryGraph?: DependencyGraph;
}
