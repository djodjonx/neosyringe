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
 * - `value`: A pre-built value registered directly.
 * - `alias`: `useExisting`, a token that answers what another token answers. It owns nothing.
 */
export type RegistrationType = 'explicit' | 'autowire' | 'parent' | 'factory' | 'value' | 'alias';

/** The token an alias stands for, as the registration names it. A chain is not followed here: the target may be an alias too. */
export interface AliasTarget {
  tokenId: TokenId;
  /** True when the target is `useInterface<T>()`: its runtime key is its id. */
  isInterfaceToken?: boolean;
}

/**
 * Where a copied expression sits in its source file. Plain data: `start` and `length` are
 * UTF-16 offsets into the text of `file` as the analysis read it.
 */
export interface SourceOrigin {
  file: string;
  start: number;
  length: number;
}

/**
 * A change the plugin makes inside a copied expression: the range `start`..`end` of the origin file
 * (absolute UTF-16 offsets) is written as `text`. Plain data. The text around it is still a copy.
 */
export interface SourceRewrite {
  start: number;
  end: number;
  text: string;
}

/**
 * A named type a generated file can refer to. Plain data, read where the type was written.
 * The generator names it with an `import type` (no runtime dependency), or by its own name where
 * the type sits in the file the output is written into.
 */
export interface TypeReference {
  /** The declared name of the type. */
  name: string;
  /** The file that declares it. */
  file: string;
  /** The name `file` exports it under (`default` for a default export). Absent: `file` does not export it. */
  exportName?: string;
  /** True for a type declared in a script file or in a lib: in scope in every file. */
  global?: true;
}

/**
 * A name a copied expression reads that is bound in its own file and is not part of the expression:
 * an import, or a top-level declaration the file exports. Plain data. The expression is copied into
 * another file, where the name means nothing until the generator imports the module and rewrites each read.
 */
export interface CopiedBinding {
  /**
   * Each read of the name inside the copied expression: absolute UTF-16 offsets in the origin file.
   * `shorthand` is the name when the read is an object shorthand (`{ Remote }`), which also writes the key.
   * `type` marks a read in a type position (a type reference, a `typeof` query, an `implements` clause): it is erased,
   * so it needs no runtime import.
   */
  ranges: ReadonlyArray<{ start: number; end: number; shorthand?: string; type?: true }>;
  /** The module that exports what the name stands for. */
  file: string;
  /** The name that module exports it under (`default` included). Absent: the name is the whole module (`import * as ns`). */
  exportName?: string;
  /**
   * The name `file` itself gives the declaration (`class Tag` exported as `Label` is `Tag`). Absent for a whole
   * module or an anonymous declaration. Where the copy lands in `file`, this is the name to read.
   */
  localName?: string;
}

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

  /** The raw source text of the factory function (for code generation). */
  factorySource?: string;

  /** Where `factorySource` was read: file, start and length of the provider expression. Plain data. */
  factoryOrigin?: SourceOrigin;

  /** Changes to apply inside `factoryOrigin` when the factory is copied. `factorySource` stays the original text. */
  factoryRewrites?: readonly SourceRewrite[];

  /**
   * The names the factory text reads that its own file binds (an import, an exported top-level class).
   * Where the factory is copied into another file, the generator imports their module and rewrites each read.
   * A name its file does not export has no entry: nothing can import it.
   */
  factoryBindings?: readonly CopiedBinding[];

  /**
   * Only an `alias` registration has one. Its `lifecycle` is a filler nobody reads: an alias is a singleton of nothing,
   * the lifecycle and the owner are the target's.
   */
  aliasTarget?: AliasTarget;

  /** The raw source text of the value expression (for 'value' type). */
  valueSource?: string;

  /** Where `valueSource` was read: file, start and length of the useValue expression. Plain data. */
  valueOrigin?: SourceOrigin;

  /** Changes to apply inside `valueOrigin` when the value is copied. `valueSource` stays the original text. */
  valueRewrites?: readonly SourceRewrite[];

  /**
   * Expression that reads a useValue capture.
   * A direct value names a const emitted once before the class.
   * A partial value reads the `extends` expression the consumer wrote (`P.part`, `p`, `part`), then `.injections[i].useValue`.
   */
  valueCapture?: string;

  /**
   * True when `valueCapture` is an expression read where the container is built (a partial's
   * `P.part.injections[i].useValue`), not the name of a const hoisted before the class.
   * Absent: `valueCapture` names a hoisted const. The generator never guesses it from the text.
   */
  valueCaptureRead?: boolean;

  /** True if this injection is scoped to the local container. */
  isScoped?: boolean;

  /** True if the factory function is async (requires initialize() before resolve()). */
  isAsync?: boolean;

  /** True if the implementation class has dispose(): void, or `[Symbol.dispose]()` when `symbolDisposer` is set */
  isDisposable?: boolean;

  /** True if the implementation class has dispose(): Promise<void>, or `[Symbol.asyncDispose]()` when `symbolDisposer` is set */
  isAsyncDisposable?: boolean;

  /**
   * True if the disposer is a method keyed by `Symbol.dispose` (`isDisposable`) or `Symbol.asyncDispose`
   * (`isAsyncDisposable`) and not one named `dispose`: the generated code finds it at run time. The key is the
   * checker's symbol of the lib, never the text of a name.
   */
  symbolDisposer?: boolean;

  /**
   * Local identifier name for the implementation symbol when it is a default export.
   * E.g. for `import Auth from './AuthService'` where `export default class AuthService {}`,
   * this is `"Auth"` — the name actually in scope in the container file.
   * Needed because resolveSymbol() follows the alias chain to the `"default"` export symbol,
   * losing the local binding name that must appear in generated `new <name>()` expressions.
   */
  implementationLocalName?: string;

  /**
   * Local identifier name for the token symbol when it is a default export.
   * Same rationale as implementationLocalName — needed for correct `this.resolve(token)` generation.
   */
  tokenLocalName?: string;

  /**
   * The identifier the registration's own file uses for the provider class, when the provider is
   * written as a plain identifier (`provider: Renamed`, `{ token: Renamed }`). It is the local binding of
   * an import, so it can differ from the class name (`import { Logger as Renamed }`).
   */
  implementationBinding?: string;

  /** Same as `implementationBinding`, for a class token. */
  tokenBinding?: string;

  /**
   * The type an interface token stands for (`useInterface<ILogger>()`), when it is a plain named type
   * the output can name. Absent: the token is a class, or its type is anonymous, generic or not nameable.
   */
  tokenType?: TypeReference;

  /** Stable id of this registration, distinct from the token id. */
  registrationId?: string;

  /** `owned` in the declaring container, `borrowed` when supplied by a parent. */
  ownership?: 'owned' | 'borrowed';

  /** Constructor edges for this registration, one per kept parameter position. */
  dependencyEdges?: DependencyEdge[];

  /** Container key that captured a `useValue`, when this registration is a value. */
  capturedInContainerId?: string;

  /** Declared factory resolutions. Absent when this registration is not a factory. */
  factoryDependencies?: FactoryDependency[];

  /** Compatible mode: the factory has no dependencies list, so its subgraph cannot be shaken. */
  opaque?: boolean;

  /**
   * Position of a scope input in the list `scopeInputs` declares. Only a scope input has one: it is a `value`
   * registration with no expression, borrowed, whose value the scope was given by `createScope({ values })`.
   */
  inputSlot?: number;
}

/** One scope input of a builder: its token, its position in `scopeInputs` and the expression that names it. */
export interface ScopeInput {
  tokenId: TokenId;
  /** Index in the declared list. A scope stores its value under this number. */
  slot: number;
  node: Node;
}

/** One entry of a factory `dependencies` list. `containerId` is `containerKeyFor` of the config. */
export interface FactoryDependency {
  tokenId: TokenId;
  all: boolean;
  source: string;
  containerId: string;
}

/** `strict` requires a dependencies list. `compatible` keeps a historical factory and marks it opaque. */
export type ValidationMode = 'strict' | 'compatible';

/** One constructor parameter demand. `paramIndex` is the source position. */
export interface DependencyEdge {
  tokenId: TokenId;
  paramIndex: number;
  optional: boolean;
  multi: boolean;
  origin: 'declared' | 'inherited';
}

/** Diagnostic for a constructor shape the analyzer will not treat as zero dependencies. */
export interface ConstructorDiagnostic {
  code: 'NEO_CONFIG_UNSUPPORTED' | 'NEO_TOKEN_BOUNDARY_UNSUPPORTED';
  message: string;
  paramName?: string;
}

/** Effective construct signature shared by the legacy and modular paths. */
export interface ConstructorSignature {
  edges: DependencyEdge[];
  diagnostics: ConstructorDiagnostic[];
}

/** A parent registration borrowed by a child container. `containerId` holds the parent containerKey. */
export interface BorrowedRegistration {
  registrationId: string;
  tokenId: TokenId;
  containerId: string;
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
  /** Unique container ID (from 'name' field or generated hash) */
  containerId: string;

  /**
   * Identity of this config: hash of the project-relative POSIX path, the
   * call position and the config text. Never the container name.
   */
  containerKey?: string;

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

  /**
   * Token IDs declared as external dependencies by a partial config (via `expects`).
   * These tokens will be provided by the host BuilderConfig, not by the partial itself.
   * PARTIAL ONLY — undefined for builder configs.
   */
  expectedExternalTokens?: Set<TokenId>;

  /** Container name from config */
  containerName?: string;

  /** Errors from useValue primitive type violations */
  valueErrors?: AnalysisError[];

  /** Multi-registrations (token -> ordered list of injection infos) */
  multiInjections?: Map<TokenId, InjectionInfo[]>;

  /** Absent means open. ADR006 line 9. `roots` on DependencyGraph stays empty. */
  optimizationMode?: 'open' | 'closed';

  /** Simple exported roots of a closed container. */
  publicRoots?: TokenId[];

  /** `{ all: token }` roots. resolveAll is allowed for these tokens only. */
  publicMultiRoots?: TokenId[];

  /** Eager tokens. They start once and are not public roots. ADR006 line 12. */
  eagerRoots?: TokenId[];

  /** Literal `runtime.profile`. Absent means full. ADR007 "Profils de génération". */
  runtimeProfile?: 'full' | 'minimal';

  /** Literal `initialization.concurrency`, a positive integer. Absent means 1, the sequential initialization. BUILDER ONLY. */
  initializationConcurrency?: number;

  /** The inputs of a literal `scopeInputs`, in declared order. A rejected entry is not listed. BUILDER ONLY. */
  scopeInputs?: ScopeInput[];

  /**
   * Partials listed in `extends`, as configuration identities, in array order.
   * `key` is the `containerKey` of the partial, `binding` the text written in `extends`.
   * An element that is not a partial has no link.
   */
  extendsLinks?: ExtendsLink[];

  /** `containerKey` of the config named by `useContainer`, followed through aliases. */
  useContainerKey?: string;

  /** What `useContainer` names: a NeoSyringe config or a `declareContainerTokens` shim. */
  useContainerKind?: 'config' | 'declared';

  /**
   * Errors of injections that never became a registration (parser errors, a partial spread),
   * in source order. They are also listed in `valueErrors`.
   */
  rejectedInjections?: AnalysisError[];

  /** Errors of the literal `optimization` and `runtime` blocks. They are also listed in `valueErrors`. */
  optimizationErrors?: AnalysisError[];

  /**
   * Parsed injections dropped because the same token is registered with and without `multi: true`.
   * They own no registration here, but a host that extends this config may still see them as one.
   */
  conflicts?: InjectionInfo[];
}

/** A partial named in `extends`: its configuration identity and the expression the consumer wrote. */
export interface ExtendsLink {
  key: string;
  binding: string;
}

/**
 * A `defineBuilderConfig` call the collector could not turn into a config.
 * `shape`: not assigned to a variable or `export default`, so it cannot be located for replacement.
 * `not-object-literal`: the argument is not an object literal.
 */
export interface RejectedBuilder {
  node: CallExpression;
  reason: 'shape' | 'not-object-literal';
}

/** Everything one collection found, in discovery order. */
export interface ConfigCollection {
  configs: Map<string, ConfigGraph>;
  rejected: RejectedBuilder[];
  /** Builders and partials as found, with rejected builders in place. */
  discovery: ReadonlyArray<ConfigGraph | RejectedBuilder>;
}

/**
 * Information about a single injection.
 */
export interface InjectionInfo {
  readonly __kind: 'info';

  /** Service definition */
  definition: ServiceDefinition;

  /** AST node for error positioning */
  node: Node;

  /** Token text for error messages */
  tokenText: string;

  /** Is this a scoped override? */
  isScoped: boolean;

  /** True when registered with multi: true */
  isMulti: boolean;

  /** Warnings produced while parsing this injection. The registration is kept. */
  warnings?: AnalysisError[];
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

  /**
   * Subset of `dependencies` that are optional — the constructor parameter is
   * marked `?` or typed `T | undefined`. These are exempt from the
   * missing-dependency validators (build and LSP) when unregistered anywhere,
   * and codegen resolves them to `undefined` instead of failing the build.
   */
  optionalDependencies?: Set<TokenId>;
}

/**
 * Complete dependency graph for a container configuration.
 */
export interface DependencyGraph {
  /** Unique container ID (from 'name' field or generated hash) */
  containerId: string;

  /**
   * Identity of this config: hash of the project-relative POSIX path, the
   * call position and the config text. Never the container name.
   */
  containerKey?: string;

  /** Parent registrations borrowed by this container. `containerId` is the parent containerKey. */
  borrowedRegistrations?: BorrowedRegistration[];

  /** All service nodes indexed by their token ID. */
  nodes: Map<TokenId, DependencyNode>;

  /** Root services that are explicitly requested or exported. */
  roots: TokenId[];

  /** Absent means open. ADR006 line 9. Distinct from `roots`, which stays []. */
  optimizationMode?: 'open' | 'closed';

  /** Simple tokens a closed container exports through resolve. */
  publicRoots?: TokenId[];

  /** Multi tokens a closed container exports through resolveAll. */
  publicMultiRoots?: TokenId[];

  /** Tokens constructed once from initialize, without becoming public. */
  eagerRoots?: TokenId[];

  /** Literal `runtime.profile`. Absent means full. ADR007 "Profils de génération". */
  runtimeProfile?: 'full' | 'minimal';

  /** Literal `initialization.concurrency`: how many initialization steps run at once. Absent means 1, the sequential order. */
  initializationConcurrency?: number;

  /**
   * The scope inputs of the container, in declared order. Each one is also a node of `nodes`: a borrowed singleton `value` with an `inputSlot`.
   * Absent: the container has no input and `createScope()` takes no argument.
   */
  scopeInputs?: ScopeInput[];

  /** One reason per registration id. ADR006 line 24. */
  retention?: Map<string, RetentionReason>;

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

  /**
   * Tokens the partials folded into this container declare with `expects`, in fold order, without
   * duplicates. The host has to provide them. Nothing generates code from it.
   */
  expectedExternalTokens?: Set<TokenId>;

  /** Tokens provided by the parent container (used for validation). */
  parentProvidedTokens?: Set<TokenId>;

  /**
   * Subset of `parentProvidedTokens` that codegen can safely delegate to at
   * runtime via a string-keyed `this.resolve(tokenId)` call: interface tokens
   * (`useInterface<T>()`) and `declareContainerTokens` entries, both of which
   * are resolved by string comparison in the generated `resolveLocal()`.
   *
   * Bare class-based tokens registered in a parent (e.g. `{ token: SomeClass }`)
   * are deliberately excluded — the parent's own `resolveLocal()` compares by
   * class identity, not by string, and codegen has no access to the parent's
   * class reference from the child's call site. Generating a string-keyed
   * `resolve()` call for those would silently never match, which is why they
   * are tracked separately instead of being lumped into `parentProvidedTokens`.
   */
  parentResolvableTokens?: Set<TokenId>;

  /**
   * For parent-provided tokens that are bare class registrations (not interface
   * tokens, so absent from `parentResolvableTokens`), the symbol needed to
   * reference that class from the child's generated code (passed to
   * Generator's import-resolution so the child can emit
   * `this.resolve(TheClass)` instead of failing to wire it). Populated only
   * when a symbol could actually be captured for the registration.
   */
  parentClassTokenSymbols?: Map<TokenId, Symbol>;

  /**
   * True when the `useContainer` parent (transitively) has async factories of
   * its own, i.e. its generated container has an `initialize()` method that
   * must run before any of its services can be resolved. Lets a child with no
   * async factories of its own still generate an `initialize()` that cascades
   * into `this.legacy`, rather than silently leaving the caller to discover
   * and sequence the parent's initialization manually.
   */
  parentHasAsyncInitialize?: boolean;

  /** Analysis errors collected during extraction (duplicates, type mismatches, etc.). */
  errors?: AnalysisError[];

  /** Multi-registration nodes (token -> ordered list of nodes) */
  multiNodes?: Map<TokenId, DependencyNode[]>;

  /** Absolute path of the source file this graph was extracted from. */
  sourceFileName?: string;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Type of analysis error.
 */
export type AnalysisErrorType = 'duplicate' | 'type-mismatch' | 'cycle' | 'missing' | 'unsupported';

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

  /**
   * Which cause of the error's code this is, set where the analyzer knows it. The fix hint reads it: it is never
   * read back from the message.
   */
  reason?: DiagnosticReason;
}

/**
 * Causes of a diagnostic code that need their own fix. A cause without a reason keeps the hint of its code.
 * - `NEO_CONFIG_UNSUPPORTED`: `value-owned`, `open-mode-roots`, `unsupported-mode`, `eager-alias`,
 *   `partial-scope-inputs`, `partial-initialization`.
 * - `NEO_DUPLICATE_PROVIDER`: `parent-override` (a token the parent container already registers).
 * - `NEO_UNKNOWN_CONTAINER`: `unknown-receiver`, `dynamic-list` (a `resolveMany` list that is not a literal).
 */
export type DiagnosticReason =
  | 'value-owned'
  | 'open-mode-roots'
  | 'unsupported-mode'
  | 'eager-alias'
  | 'partial-scope-inputs'
  | 'partial-initialization'
  | 'parent-override'
  | 'unknown-receiver'
  | 'dynamic-list';

/** Machine-readable diagnostic codes this analyzer emits. */
export type DiagnosticCode =
  | 'NEO_CONFIG_UNSUPPORTED'
  | 'NEO_FACTORY_DEPENDENCIES_REQUIRED'
  | 'NEO_DUPLICATE_PROVIDER'
  | 'NEO_MISSING_PROVIDER'
  | 'NEO_UNKNOWN_CONTAINER'
  | 'NEO_MULTI_REQUIRES_RESOLVE_ALL'
  | 'NEO_CYCLE'
  | 'NEO_UNDECLARED_FACTORY_DEP'
  | 'NEO_FACTORY_CONTEXT_EXPIRED'
  | 'NEO_ASYNC_TRANSIENT'
  | 'NEO_TOKEN_BOUNDARY_UNSUPPORTED'
  | 'NEO_ROOT_NOT_EXPORTED'
  | 'NEO_CLOSED_REQUIRES_STRICT'
  | 'NEO_DISPOSABLE_TRANSIENT_CAPTURED';

/**
 * Why one registration stays or goes.
 * T19 reads `kind` and `token`. ADR006 lines 24 and 29-31.
 * Rank when several apply: root, eager, multi-contribution-of, dependency-of, parent-boundary, unreachable.
 */
export type RetentionReason =
  | { kind: 'root' }
  | { kind: 'eager' }
  | { kind: 'dependency-of'; token: TokenId }
  | { kind: 'multi-contribution-of'; token: TokenId }
  | { kind: 'parent-boundary' }
  | { kind: 'unreachable' };

/**
 * An error detected during dependency graph analysis.
 */
export interface AnalysisError {
  /** Type of error. */
  type: AnalysisErrorType;

  /** Stable diagnostic code. Messages may change; codes do not. */
  code?: DiagnosticCode;

  /** `warning` in compatible mode. Absent means an error. */
  severity?: 'error' | 'warning';

  /** Error message. */
  message: string;

  /** The AST node where the error occurred. */
  node: Node;

  /** The source file containing the error. */
  sourceFile: SourceFile;

  /** Additional context for the message. */
  context?: ErrorContext;

  /** `containerKey` of the container the resolve call was checked against. */
  containerId?: string;
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
