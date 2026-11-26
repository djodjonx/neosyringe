import type * as ts from 'typescript';
import { relative, isAbsolute, dirname } from 'node:path';
import { DependencyGraph, DependencyNode, SourceRewrite, TokenId, TypeReference } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';
import { topologicalSort } from './TopologicalSorter';
import { generateFactories, generateMultiFactories, getFactoryName, resolveTokenKey, type GetImport } from './FactoryEmitter';
import { generateResolveCases, generateResolveAllMethod, generateMultiResolveGuard, buildAsyncResolveGuard, legacyParentInterface, parentOpenCheck, resolveListenerOverload, singleOverload, isBorrowedInstance, afterStore } from './ResolveEmitter';
import { hasAsyncFactories, generateInitializeMethod, generateSyncInitializeMethod, generateEagerSyncInitialize, generateDestroyMethod, generateCreateScopeMethod, generateOverrideMethods, touchClosedMethod, assertParentsMethod, syncNeoFailMethod } from './LifecycleEmitter';
import { exportedRootIds } from '../analyzer/parsers/ConfigParser';
import { emitOptimizedContainer } from './DirectEmitter';
import { DISPATCH_LINEAR_MAX } from './dispatchEmitter';
import { linkedFactoryLeaseHelpers } from './factoryLeaseEmitter';
import { providerTypesOf, type GetProviderTypes } from './providerTypes';
import {
  NamePool,
  concat,
  copyFromSnapshot,
  fragment,
  render,
  snapshotOfFiles,
  type CopyMapping,
  type Fragment,
  type Piece,
  type Snapshot,
  type UserCopy,
} from './fragments';
import { TSContext } from '../TSContext';
import {
  artifactDescriptor,
  hashArtifactDescriptor,
  resolveArtifactIdentity,
  type CollisionRegistry,
} from '../analyzer/shared/artifactIdentity';

/**
 * Returns a usable identifier name for a symbol in the context of direct symbol names
 * (useDirectSymbolNames = true, i.e. the build plugin path where generated code is inlined).
 *
 * When a class is imported as a default export (`import Auth from './AuthService'`), TypeScript
 * resolves the symbol to the `"default"` export symbol — a reserved word that cannot appear
 * as an identifier in `new default(...)`. The correct name to emit is the local binding as it
 * appears in the container file (`"Auth"`), NOT the class declaration name (`"AuthService"`),
 * because only the local binding is in scope in the generated code.
 *
 * @param symbol - The resolved symbol (getName() may return "default")
 * @param localName - The local identifier name from the container file (e.g. "Auth").
 *   Captured by InjectionParser before resolveSymbol() follows the alias chain.
 *
 * @example
 * // export default class AuthService {}
 * // import Auth from './AuthService'
 * // symbol.getName() === 'default'
 * resolveDefaultExportName(symbol, 'Auth') // → 'Auth'  ← uses local name (correct)
 * resolveDefaultExportName(symbol)         // → 'AuthService'  ← fallback (only when localName missing)
 */
function resolveDefaultExportName(symbol: ts.Symbol, localName?: string): string {
  const name = symbol.getName();
  if (name !== 'default') return name;

  // Prefer the local import identifier — it is the name actually in scope in the container file.
  if (localName) return localName;

  // Fallback: use the class/function declaration name (works when class name === import alias).
  const decl = symbol.declarations?.[0];
  if (!decl) return name;

  if (TSContext.ts.isClassDeclaration(decl) && decl.name) {
    return decl.name.text;
  }
  if (TSContext.ts.isFunctionDeclaration(decl) && decl.name) {
    return decl.name.text;
  }

  return name;
}

/** A file name as one spelling, so two names of one file compare equal. `undefined` stays `undefined`. */
function normalizeFile(fileName: string | undefined): string | undefined {
  return fileName?.replace(/\\/g, '/');
}

/**
 * One `import type { <exportName> as <alias> } from '<file>'` the output asks for, or, with no `exportName`,
 * `import type * as <alias> from '<file>'`. Erased: the output gains no runtime dependency.
 */
interface TypeImport {
  file: string;
  exportName?: string;
  alias: string;
}

/**
 * Generates TypeScript code for the dependency injection container.
 *
 * Takes a validated dependency graph and produces:
 * - Import statements for all dependencies
 * - Factory functions for each service
 * - A NeoContainer class with resolve logic
 *
 * The actual emission logic is split into focused modules:
 * - {@link generateFactories} / {@link generateMultiFactories} (FactoryEmitter)
 * - {@link generateResolveCases} / {@link generateResolveAllMethod} (ResolveEmitter)
 * - {@link generateInitializeMethod} / {@link generateDestroyMethod} (LifecycleEmitter)
 */
export class Generator {
  /** Name of the generated container class — see {@link getGeneratedClassSuffix}. */
  private readonly containerClassName: string;
  /** Name of the generated "not found" error class — see {@link getGeneratedClassSuffix}. */
  private readonly notFoundErrorClassName: string;
  /** Interface that types the `useContainer` parents the class reads. */
  private readonly legacyParentName: string;
  /** Identity of this container among the artifacts of the build. Keys the names it takes from the pool. */
  private readonly artifactKey: string;
  /** Names of generated top-level bindings. Shared by every Generator of one source file. */
  private readonly names: NamePool;

  /**
   * Creates a new Generator.
   *
   * @param graph - The validated dependency graph to generate code from.
   * @param useDirectSymbolNames - When true, symbol names are referenced directly
   *   (e.g. `MyService`) instead of via namespace imports (`Import_0.MyService`).
   *   Use true when the generated code is inlined inside the same file as the
   *   original definitions (unplugin transform); use false (default) when the
   *   generated code is written to a separate output file that needs explicit imports.
   * @param outputDir - Directory where the generated file will be written. Used to
   *   compute relative import paths when `useDirectSymbolNames` is false. Defaults
   *   to `process.cwd()` when not provided.
   */
  constructor(
    private graph: DependencyGraph,
    private useDirectSymbolNames: boolean = false,
    private outputDir?: string,
    /**
     * Whether to embed the `_graph`/`_dependencyGraph` debug data (token ids
     * and dependency edges) in the generated source at all. Unlike the
     * previous NODE_ENV runtime check alone, this is a true build-time
     * decision: when false, the literal data is never written into the
     * output, so there is nothing for a bundler's dead-code elimination to
     * depend on — this is what actually matters for the plain `tsc`/ts-patch
     * path, which has no bundler/minifier step at all. The getters still
     * exist either way (returning `[]` when disabled), so `container._graph`
     * is never `undefined` — only its payload changes.
     */
    private emitDebugHelpers: boolean = true,
    /**
     * When true, the generated override() / clearOverrides() perform a real
     * reconfigure. When false they reject NEO_TEST_API_DISABLED. The choice
     * is fixed here so the emitted source never reads `process`.
     */
    private testOverrides: boolean = false,
    /**
     * Which container emitter to use. `reference` is the generic resolver, kept as the
     * witness; `optimized` emits one direct accessor per registration (DirectEmitter).
     * Undefined picks `optimized`, for every profile and mode.
     */
    private emitter?: 'reference' | 'optimized',
    /**
     * Shared collision registry for this build, and an optional hash used by tests
     * to force two descriptors onto one key. The suffix is an artifact id, never
     * a public token id.
     */
    private identityOptions?: {
      collisions?: CollisionRegistry;
      hash?: (descriptor: string) => string;
    },
    /**
     * Where the output comes from. `names` is the pool of the source file this output is
     * written into: pass the same pool to every Generator of one file so their bindings never
     * collide with each other or with a name the file declares. Absent: a private pool, which is
     * right when the output has a file of its own. `snapshot` is the text user expressions are
     * copied from. Absent: the files the graph was read from.
     */
    private provenance?: {
      snapshot?: Snapshot;
      names?: NamePool;
    },
    /**
     * Internal. `linearMax` is the number of rows up to which a dispatch table of the optimized emitter is the linear
     * `if (token === key)` cases and not the shared table: `0` forces the table, `Infinity` forces the cases. Absent:
     * `DISPATCH_LINEAR_MAX`. The reference emitter has no table and ignores it.
     */
    private dispatch?: { linearMax?: number }
  ) {
    // Check for analysis errors and throw the first one for CLI compatibility
    if (graph.errors && graph.errors.length > 0) {
      const firstError = graph.errors[0];
      if (firstError.type === 'duplicate') {
        throw new DuplicateRegistrationError(firstError.message, firstError.node, firstError.sourceFile);
      } else if (firstError.type === 'type-mismatch') {
        throw new TypeMismatchError(firstError.message, firstError.node, firstError.sourceFile);
      }
    }

    // In useDirectSymbolNames mode (unplugin inline transform), multiple
    // defineBuilderConfig() calls can share the same module scope — e.g. a parent
    // and child container in the same file. Without a per-call-site suffix, every
    // call site would emit an identically-named `class NeoContainer` /
    // `class NeoServiceNotFoundError`, which is a SyntaxError (duplicate lexical
    // declaration) once two of them land in the same scope.
    //
    // In separate-output-file mode (useDirectSymbolNames=false), each container
    // already lives alone in its own generated file, so no suffix is needed —
    // keep names stable there for backward compatibility. The identity is still
    // registered, so two containers that collapse to one key fail in either mode.
    const artifactKey = this.getGeneratedClassSuffix();
    this.artifactKey = artifactKey;
    this.names = provenance?.names ?? new NamePool([]);
    const suffix = this.useDirectSymbolNames ? `_${artifactKey}` : '';
    this.containerClassName = this.names.forKey(`class:${artifactKey}`, `NeoContainer${suffix}`);
    this.notFoundErrorClassName = this.names.forKey(`error:${artifactKey}`, `NeoServiceNotFoundError${suffix}`);
    this.legacyParentName = this.names.forKey(`legacy:${artifactKey}`, `NeoLegacyParent${suffix}`);
  }

  /**
   * Artifact id for this container. The class suffix uses it in direct mode.
   * Registration runs in both modes: a second, different descriptor on the same
   * key throws `identity collision`.
   */
  private getGeneratedClassSuffix(): string {
    const identity = resolveArtifactIdentity({
      sourceFileName: this.graph.sourceFileName,
      defineBuilderConfigStart: this.graph.defineBuilderConfigStart,
      containerId: this.graph.containerId,
    });
    const descriptor = artifactDescriptor(identity);
    const key = hashArtifactDescriptor(descriptor, this.identityOptions?.hash);
    this.identityOptions?.collisions?.register(key, descriptor);
    return key;
  }

  /** The namespace alias of an import of `filePath`. One per file for this container, kept free of every other name of the source file. */
  private importAlias(filePath: string, preferred: string): string {
    return this.names.forKey(`import:${this.artifactKey}:${filePath}`, preferred);
  }

  /**
   * Import lines for the symbols registered in `imports`. Must run after every emitter
   * has called getImport: that call is what registers an import.
   */
  private renderImportLines(
    imports: Map<string, string>,
    sourceGraph: DependencyGraph,
    typeImports: ReadonlyMap<string, TypeImport>,
  ): string[] {
    const importLines: string[] = [];
    // Base directory for relative import paths:
    // - useDirectSymbolNames=true: relative to the container source file (so the injected
    //   import resolves correctly from the file's perspective)
    // - useDirectSymbolNames=false: relative to the output directory (generated file)
    const base = this.useDirectSymbolNames
      ? (sourceGraph.sourceFileName ? dirname(sourceGraph.sourceFileName) : process.cwd())
      : (this.outputDir ?? process.cwd());
    const specifierFor = (filePath: string): string => {
      let importPath: string;
      if (isAbsolute(filePath)) {
        const rel = relative(base, filePath).replace(/\\/g, '/');
        importPath = rel.startsWith('.') ? rel : `./${rel}`;
      } else {
        importPath = filePath;
      }
      // Strip TS/TSX extensions in inline mode: the user's own import of the same file
      // typically uses no extension (or .js). Using './login.ts' alongside './login'
      // risks two distinct module specifiers which some toolchains won't deduplicate,
      // breaking the identity comparison token === Import_N.default.
      if (this.useDirectSymbolNames) {
        importPath = importPath.replace(/\.(ts|tsx|mts|cts)$/, '');
      }
      return importPath;
    };
    if (imports.size > 0) {
      for (const [filePath, alias] of imports) {
        importLines.push(`import * as ${alias} from '${specifierFor(filePath)}';`);
      }
    }
    // Types the getters name. `import type` is erased: the output gains no runtime dependency.
    for (const { file, exportName, alias } of typeImports.values()) {
      importLines.push(exportName === undefined
        ? `import type * as ${alias} from '${specifierFor(file)}';`
        : `import type { ${exportName} as ${alias} } from '${specifierFor(file)}';`);
    }
    // A pruned provider's module still runs when it has a top-level effect. ADR006 lines 35-38.
    for (const filePath of loadEffectFiles(sourceGraph)) {
      if (imports.has(filePath)) continue;
      importLines.push(`import '${specifierFor(filePath)}';`);
    }

    return importLines;
  }

  /** The optimized emitter is the default of every profile and mode. The reference emitter is asked for by name. */
  private useOptimizedEmitter(): boolean {
    return this.emitter !== 'reference';
  }

  /**
   * Generates the complete container code as a string.
   * @returns TypeScript source code for the generated container.
   */
  public generate(): string {
    return this.generateRendered().code;
  }

  /**
   * The container code, and where each user expression in it was copied from.
   * `copies` lists a range of `code` and the range of the source file it is a copy of, both in
   * UTF-16 units. An expression the plugin rewrote is generated text and has no entry.
   */
  public generateRendered(): { code: string; copies: readonly CopyMapping[] } {
    const snapshot = this.snapshotOfGraph();
    return render(this.build(copyFromSnapshot(snapshot)).parts, snapshot);
  }

  /** The files the graph's user expressions were read from, as the analysis saw them. */
  private snapshotOfGraph(): Snapshot {
    if (this.provenance?.snapshot) return this.provenance.snapshot;
    const files = new Map<string, string>();
    visitServices(this.graph, (node) => {
      for (const origin of [node.service.factoryOrigin, node.service.valueOrigin]) {
        if (!origin || files.has(origin.file)) continue;
        // A registration is parsed from the file its origin names, so the node's file holds that text.
        const file = node.service.registrationNode.getSourceFile?.();
        if (file) files.set(origin.file, file.text);
      }
    });
    return snapshotOfFiles(files);
  }

  /**
   * Hoisted useValue consts get their name from the pool, so a name the file declares is never
   * taken twice. A name nobody else wants stays as the analysis wrote it.
   */
  private withPooledCaptures(graph: DependencyGraph): DependencyGraph {
    let changed = false;
    const pooled = (node: DependencyNode): DependencyNode => {
      const capture = node.service.valueCapture;
      if (!capture || node.service.valueCaptureRead) return node;
      const name = this.names.forKey(`capture:${this.artifactKey}:${capture}`, capture);
      if (name === capture) return node;
      changed = true;
      return { ...node, service: { ...node.service, valueCapture: name } };
    };
    const nodes = new Map<TokenId, DependencyNode>();
    for (const [tokenId, node] of graph.nodes) nodes.set(tokenId, pooled(node));
    let multiNodes = graph.multiNodes;
    if (graph.multiNodes) {
      multiNodes = new Map();
      for (const [tokenId, list] of graph.multiNodes) multiNodes.set(tokenId, list.map(pooled));
    }
    return changed ? { ...graph, nodes, multiNodes } : graph;
  }

  private build(copy: UserCopy): Fragment {
    const sourceGraph = this.withPooledCaptures(this.graph);
    const retained = dropUnreachable(sourceGraph);
    const sorted = topologicalSort(retained.nodes);
    const imports = new Map<string, string>(); // filePath -> importAliasPrefix

    // Build a map from resolved symbol → local identifier name for default exports.
    // InjectionParser captures the local name (e.g. "Auth" from `import Auth from './AuthService'`)
    // before resolveSymbol() follows the alias chain and loses it.
    const localNameBySymbol = new Map<ts.Symbol, string>();
    const indexLocalNames = (node: DependencyNode) => {
      const { implementationSymbol, implementationLocalName, tokenSymbol, tokenLocalName } = node.service;
      if (implementationSymbol && implementationLocalName) localNameBySymbol.set(implementationSymbol, implementationLocalName);
      if (tokenSymbol && tokenLocalName) localNameBySymbol.set(tokenSymbol, tokenLocalName);
    };
    for (const node of retained.nodes.values()) indexLocalNames(node);
    if (retained.multiNodes) {
      for (const nodes of retained.multiNodes.values()) nodes.forEach(indexLocalNames);
    }

    // For default exports in useDirectSymbolNames=true mode, pre-register their source file
    // in the imports map so we generate an explicit `import * as Import_N` statement.
    //
    // WHY: bundlers (rolldown, webpack, esbuild) resolve import bindings by RENAMING them
    // during inlining. A `const __neo_Login = Login` capture was our previous approach, but
    // rolldown fails to rename `Login` in injected code because that reference was added by
    // the transform after its initial scope analysis. The result: `Login is not defined` at
    // runtime in the bundle.
    //
    // The correct fix is to use `import * as Import_N from './path'` + `Import_N.default`:
    // an explicit namespace import is self-contained — the bundler never needs to rename it
    // and always knows what `Import_N.default` refers to.
    if (this.useDirectSymbolNames) {
      for (const [symbol] of localNameBySymbol) {
        const decl = symbol.declarations?.[0];
        if (decl) {
          const filePath = decl.getSourceFile().fileName;
          if (!imports.has(filePath)) {
            // Use __neo_ prefix to avoid collisions with any existing identifier in the
            // user's file (code is injected inline, not in a separate generated file).
            imports.set(filePath, this.importAlias(filePath, `__neo_Import_${imports.size}`));
          }
        }
      }
    }

    // The container's own file, and what it binds. The generated code is written into this file, so a bare
    // identifier is right only for a name this file owns: the local binding the registration wrote
    // (`import { Logger as Renamed }` is `Renamed`, never `Logger`). A class that a partial of another file
    // registers, or that a registration reaches through a namespace import (`deps.Logger`), has no binding
    // here: the output imports its file and reads the export from the namespace.
    const containerFile = normalizeFile(sourceGraph.sourceFileName);
    const bindingBySymbol = new Map<ts.Symbol, string>();
    const unboundSymbols = new Set<ts.Symbol>();
    const indexBindings = (node: DependencyNode) => {
      const { implementationSymbol, implementationBinding, tokenSymbol, tokenBinding } = node.service;
      const registeredIn = normalizeFile(node.service.registrationNode?.getSourceFile?.()?.fileName);
      // A hand-built graph has no tree to read: its names are taken as written.
      const readable = registeredIn !== undefined;
      const here = !readable || containerFile === undefined || registeredIn === containerFile;
      const note = (symbol: ts.Symbol | undefined, binding: string | undefined) => {
        if (!symbol) return;
        if (here && binding !== undefined) {
          if (!bindingBySymbol.has(symbol)) bindingBySymbol.set(symbol, binding);
        } else if (readable) {
          unboundSymbols.add(symbol);
        }
      };
      note(implementationSymbol, implementationBinding);
      note(tokenSymbol, tokenBinding);
    };
    for (const node of retained.nodes.values()) indexBindings(node);
    if (retained.multiNodes) {
      for (const nodes of retained.multiNodes.values()) nodes.forEach(indexBindings);
    }

    const getImport: GetImport = (symbol: ts.Symbol): string => {
      if (this.useDirectSymbolNames) {
        // Default exports: use Import_N.default (explicit namespace import, bundler-safe).
        if (localNameBySymbol.has(symbol)) {
          const decl = symbol.declarations?.[0];
          if (decl) {
            const filePath = decl.getSourceFile().fileName;
            const alias = imports.get(filePath);
            if (alias) return `${alias}.default`;
          }
        }
        // Named exports: the local binding of the registration is stable — bundlers correctly rename all references.
        const bound = bindingBySymbol.get(symbol);
        if (bound !== undefined) return bound;
        const declared = normalizeFile(symbol.declarations?.[0]?.getSourceFile().fileName);
        if (unboundSymbols.has(symbol) && declared !== undefined && declared !== containerFile) {
          return getForeignImport(symbol);
        }
        return resolveDefaultExportName(symbol);
      }
      const decl = symbol.declarations?.[0];
      if (!decl) {
        throw new Error(
          `[Generator] Cannot resolve import for symbol '${symbol.getName()}': no declaration found. ` +
          `Ensure all service implementations have explicit source declarations (no ambient-only types).`
        );
      }
      const filePath = decl.getSourceFile().fileName;
      if (!imports.has(filePath)) {
        imports.set(filePath, this.importAlias(filePath, `Import_${imports.size}`));
      }
      return `${imports.get(filePath)}.${symbol.getName()}`;
    };

    /** The namespace alias of an import of `filePath`, registered on first use. */
    const namespaceOf = (filePath: string): string => {
      const existing = imports.get(filePath);
      if (existing !== undefined) return existing;
      const prefix = this.useDirectSymbolNames ? '__neo_Import_' : 'Import_';
      const alias = this.importAlias(filePath, `${prefix}${imports.size}`);
      imports.set(filePath, alias);
      return alias;
    };

    // Like getImport, but emits an explicit namespace import — used only
    // for a parent-provided class token (see FactoryEmitter.resolveConstructorArgs).
    // The one exception is a class the container's own file declares: it is read by its own name.
    // Unlike the container's own local dependencies (necessarily already imported
    // into this file, since the user wrote `{ token: X }` here themselves), a
    // class living in a useContainer parent's file is not guaranteed to be in
    // scope here at all — so the bare-identifier shortcut getImport takes for
    // same-file/named exports in inline mode is not safe to reuse for this case.
    const getForeignImport: GetImport = (symbol: ts.Symbol): string => {
      const decl = symbol.declarations?.[0];
      if (!decl) {
        throw new Error(
          `[Generator] Cannot resolve import for parent-provided class token '${symbol.getName()}': ` +
          `no declaration found.`
        );
      }
      // Inline, a class the container file itself declares is in scope under its own name: the file never imports itself.
      if (this.useDirectSymbolNames && containerFile !== undefined && normalizeFile(decl.getSourceFile().fileName) === containerFile) {
        return resolveDefaultExportName(symbol);
      }
      return `${namespaceOf(decl.getSourceFile().fileName)}.${symbol.getName()}`;
    };

    // A type in another file is named through an `import type`, kept in `typeImports` until the import lines
    // are written (after every emitter ran). `exportName` undefined is the whole module (`import type * as`).
    const typeImports = new Map<string, TypeImport>();
    const typeAliasOf = (file: string, exportName: string | undefined, preferred: string): string => {
      const key = `${file}\0${exportName ?? ''}`;
      let entry = typeImports.get(key);
      if (!entry) {
        const alias = this.names.forKey(`type:${this.artifactKey}:${key}`, `__neo_Type_${preferred}`);
        entry = { file, exportName, alias };
        typeImports.set(key, entry);
      }
      return entry.alias;
    };

    // A factory of another file is copied into this one: the names its text reads are bound there, not here.
    // Each read becomes a member of a namespace import of the module that exports it (inline layout only: a
    // separate output file binds none of the user's names). A name read only in type positions is imported
    // with `import type`, so the copy adds no runtime dependency the user did not write.
    const emitted = this.useDirectSymbolNames
      ? withBindingRewrites(retained, containerFile, namespaceOf, typeAliasOf)
      : retained;

    // The type of each getter. A type the output cannot name has no text: that getter answers `unknown`
    // (providerTypes.ts).
    const nameType = (reference: TypeReference): string | undefined => {
      if (reference.global) return reference.name;
      // Inline, the output is written into the file that declares the type: its own name is in scope.
      if (this.useDirectSymbolNames && normalizeFile(reference.file) === containerFile) return reference.name;
      // A declaration file has no module specifier this output can write.
      if (reference.exportName === undefined || /\.d\.[cm]?ts$/.test(reference.file)) return undefined;
      return typeAliasOf(reference.file, reference.exportName, reference.name);
    };
    const providerTypes: GetProviderTypes = (node) => providerTypesOf(node.service, getImport, nameType);

    // A hoisted useValue constant carries the type its registration is declared under: the user's own
    // `Injection` typed the expression with it, and a bare `const` would widen its literals. Resolved here,
    // before the import lines are written, because naming a type may add an `import type`.
    const hoistTypes = new Map<string, string>();
    visitServices(sourceGraph, (node) => {
      const capture = node.service.valueCapture;
      if (!capture || node.service.valueCaptureRead) return;
      // A pruned value is evaluated once for its effect (ADR006): nothing reads it, so its type is not named, and no `import type` is written for it.
      if (isUnreachable(sourceGraph, node)) return;
      const type = providerTypes(node).creator;
      if (type !== undefined) hoistTypes.set(capture, type);
    });

    // A container with no async factories of its own still needs initialize()
    // (and the guard below) if its useContainer parent/legacy chain has them —
    // otherwise resolving from this container before the parent is ready would
    // silently succeed for local tokens and only fail deep inside the parent's
    // own resolve(), with no guidance that it's an initialization-order issue.
    const hasAsync = hasAsyncFactories(emitted) || !!emitted.parentHasAsyncInitialize;
    const closed = emitted.optimizationMode === 'closed';
    const resolveGuard = buildAsyncResolveGuard(hasAsync);
    const eagerLines = eagerSyncLines(emitted, getImport, hasAsync);

    if (this.useOptimizedEmitter()) {
      const state = containerState(emitted, hasAsync, eagerLines, emitted.runtimeProfile === 'minimal');
      const containerClass = emitOptimizedContainer({
        graph: emitted,
        sorted,
        getImport,
        getForeignImport,
        hasAsync,
        closed,
        minimal: emitted.runtimeProfile === 'minimal',
        testOverrides: this.testOverrides,
        className: this.containerClassName,
        notFoundErrorClassName: this.notFoundErrorClassName,
        legacyParentName: this.legacyParentName,
        eagerLines,
        providerTypes,
        dispatchLinearMax: this.dispatch?.linearMax ?? DISPATCH_LINEAR_MAX,
        stateFields: `${state.stateFields}${state.eagerField}`,
        ...rootMembers(emitted, closed, getImport),
        runtimeHelpers: runtimeHelpers(hasAsync),
        debugGetters: this.emitDebugGetter(emitted),
        copy,
      });
      // Imports are read after the class: emitting it is what registers them.
      return fragment`${generatedContainerHeader()}${openModeMark(sourceGraph.optimizationMode)}
${this.renderImportLines(imports, sourceGraph, typeImports).join('\n')}
${concat([...captureHoists(sourceGraph, copy, hoistTypes), ...residualValueReads(sourceGraph)], '\n')}

${containerClass}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
    }

    const factories = generateFactories(emitted, sorted, getImport, getForeignImport, hasAsync, closed, undefined, copy, providerTypes, this.containerClassName);
    const resolveCases = generateResolveCases(
      emitted,
      sorted,
      getImport,
      hasAsync,
      `${this.containerClassName}.formatToken`,
    );
    const multiFactories = generateMultiFactories(emitted, getImport, getForeignImport, hasAsync, closed, undefined, copy, providerTypes, this.containerClassName);
    // The policy and the lease of the declared factories: only the helpers a creator asks for.
    const factoryHelpers = linkedFactoryLeaseHelpers(this.containerClassName, [...factories, ...multiFactories]);
    const resolveAllMethod = generateResolveAllMethod(emitted, getImport, hasAsync, closed);
    const initializeMethod = hasAsync
      ? generateInitializeMethod(emitted, sorted, getImport, hasAsync, eagerLines)
      : eagerLines.length > 0
        ? generateEagerSyncInitialize(eagerLines)
        : generateSyncInitializeMethod();
    const createScopeMethod = generateCreateScopeMethod(this.containerClassName, hasAsync);
    const destroyMethod = generateDestroyMethod(emitted, sorted, getImport, hasAsync);
    const overrideMethods = generateOverrideMethods(emitted, sorted, getImport, hasAsync, this.testOverrides);

    const importLines = this.renderImportLines(imports, sourceGraph, typeImports);

    // A successful legacy resolve borrows that instance. A throw must not mark the caller's own result.
    const borrowReset = '';
    const borrowBefore = `const legacyResult = legacyContainer.resolve(token);
                    if (legacyResult != null) this._borrowed.add(legacyResult);`;
    const borrowNotify = '';
    const { stateFields, eagerField } = containerState(emitted, hasAsync, eagerLines);
    const runtimeHelpersText = runtimeHelpers(hasAsync);
    const captureLines: Piece[] = [...captureHoists(sourceGraph, copy, hoistTypes), ...residualValueReads(sourceGraph)];
    const multiGuard = generateMultiResolveGuard(emitted, getImport, hasAsync);
    const assertOne = closed ? 'this._assertRoot(token, false);' : '';
    const resolveInterior = `
    ${borrowReset}${parentOpenCheck(hasAsync)}
    ${multiGuard}${multiGuard ? '\n    ' : ''}// 0. An overridden token always wins, even over a cached real instance.
    if (this.overrides.has(token)) {
      if (!this.instances.has(token)) {
        const __neoMock = this.overrides.get(token)!();
        this.instances.set(token, __neoMock);
        if (__neoMock != null) this._borrowed.add(__neoMock);
      }
      const overridden = this.instances.get(token);
      this.notifyResolve(token, overridden);
      return overridden;
    }

    // 1. Try to resolve locally (or create if singleton)
    const result = this.resolveLocal(token);
    // A stored undefined is a value. A missing token still falls through.
    if (result !== undefined || this.instances.has(token)) {
      this.notifyResolve(token, result);
      return result;
    }

    // 2. Delegate to parent/legacy containers (useContainer's target, whether a
    // NeoSyringe container or a declareContainerTokens() legacy adapter, always
    // ends up here)
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) {
                    ${borrowBefore}
                    this.notifyResolve(token, legacyResult);
                    return legacyResult;
                }
            } catch (e) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${this.notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${this.containerClassName}.formatToken(token)}\`);`;

    const resolveMethod = hasAsync
      ? `${singleOverload('public', 'resolve')}
    this._guardPublic();
    ${closed ? assertOne + '\n    ' : ''}return this._resolveInternal(token);
  }

  ${singleOverload('private', '_resolveInternal')}${resolveInterior}
  }`
      : closed
        ? `${singleOverload('public', 'resolve')}
    ${assertOne}
    return this._resolveInternal(token);
  }

  ${singleOverload('private', '_resolveInternal')}${resolveInterior}
  }`
        : `${singleOverload('public', 'resolve')}
    ${resolveGuard}${resolveInterior}
  }`;

    const { rootFields, assertRootMethod } = rootMembers(emitted, closed, getImport);

    return fragment`${generatedContainerHeader()}${openModeMark(sourceGraph.optimizationMode)}
${importLines.join('\n')}
${concat(captureLines, '\n')}

${legacyParentInterface(this.legacyParentName)}

class ${this.notFoundErrorClassName} extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class ${this.containerClassName} {
  private instances = new Map<unknown, unknown>();
  private overrides = new Map<unknown, () => unknown>();
  private resolveListeners = new Set<(token: unknown, instance: unknown) => void>();
  ${stateFields}${eagerField}${rootFields}

  // -- Factories --
  ${concat([...factories, ...multiFactories], '\n  ')}${factoryHelpers.length > 0 ? fragment`\n\n  ${concat(factoryHelpers, '\n\n  ')}` : ''}

  constructor(
    private legacy?: ${this.legacyParentName}[],
    private name: string = 'NeoContainer'
  ) {}

  ${runtimeHelpersText}${assertRootMethod}

  ${initializeMethod}

  ${createScopeMethod}

  ${overrideMethods}

  /**
   * Subscribes to container events — currently only 'resolve', fired with the
   * token and the resolved instance every time resolve() succeeds (whether
   * served from cache, freshly created, an override, or a parent/legacy
   * container). Returns an unsubscribe function. A listener that throws is
   * caught and ignored — a bug in an observability hook must never break the
   * actual resolution it's observing.
   */
  ${resolveListenerOverload()}
    this.resolveListeners.add(listener);
    return () => { this.resolveListeners.delete(listener); };
  }

  private notifyResolve(token: unknown, instance: unknown): void {
    ${borrowNotify}for (const listener of this.resolveListeners) {
      try {
        listener(token, instance);
      } catch {
        // A listener's own bug must never break the resolution it's observing.
      }
    }
  }

  ${resolveMethod}

  /**
   * Formats a token for error messages: a class token becomes its declared
   * name (not its entire stringified source), and a string token has its
   * trailing content-hash suffix stripped (not the raw hashed id).
   */
  private static formatToken(token: unknown): string {
    if (typeof token === 'function') return token.name || String(token);
    if (typeof token !== 'string') return String(token);
    const parts = token.split('_');
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^[a-f0-9]{6,12}$/i.test(last)) {
      return parts.slice(0, -1).join('_');
    }
    return token;
  }

  ${destroyMethod}

  ${resolveAllMethod}

  private resolveLocal(token: unknown): unknown {
    ${resolveCases.join('\n    ')}
    return undefined;
  }

  ${this.emitDebugGetter(emitted)}
}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
  }

  /**
   * Generates only the instantiation expression: new NeoContainer(...)
   * This is used to replace defineBuilderConfig(...) in the source.
   * The comment lets a bundler drop a container that nothing reads.
   * initialize(), destroy() and provider construction stay unmarked.
   */
  public generateInstantiation(): string {
    const legacyArgs = this.graph.legacyContainers ? `[${this.graph.legacyContainers.join(', ')}]` : 'undefined';
    const nameArg = this.graph.containerName ? JSON.stringify(this.graph.containerName) : 'undefined';
    return this.annotatePureInstantiation(`new ${this.containerClassName}(${legacyArgs}, ${nameArg})`);
  }

  /** A bundler drops an unused `new` only when this comment marks the call. */
  private annotatePureInstantiation(expression: string): string {
    return `/* @__PURE__ */ ${expression}`;
  }

  /**
   * Generates the container variable declaration with the user's export modifier.
   * If no modifier is specified (undefined), defaults to 'export' for backward compatibility.
   */
  private generateContainerVariable(): string {
    const variableName = this.graph.exportedVariableName;
    const instantiation = this.generateInstantiation();
    const exportModifier = this.graph.variableExportModifier;

    if (exportModifier === 'export default') {
      if (variableName) {
        return `
// -- Container Instance --
const ${variableName} = ${instantiation};
export default ${variableName};
`;
      } else {
        return `
// -- Container Instance --
export default ${instantiation};
`;
      }
    } else if (exportModifier === 'none') {
      return `
// -- Container Instance --
const ${variableName || 'container'} = ${instantiation};
`;
    } else {
      // 'export' or undefined — default to 'export' for backward compatibility
      return `
// -- Container Instance --
export const ${variableName || 'container'} = ${instantiation};
`;
    }
  }

  /**
   * Emits the `_graph` debug getter into the generated container class.
   *
   * Token IDs are always embedded as a literal in the generated source.
   * In production (`NODE_ENV === 'production'`), the runtime branch returns `[]`
   * so resolved values are not exposed at runtime, but the literals remain in
   * the bundle. Bundlers with static dead-code elimination (e.g., esbuild with
   * NODE_ENV inlined) will strip the literal entirely.
   */
  private emitDebugGetter(graph: DependencyGraph): string {
    if (!this.emitDebugHelpers) {
      // Build-time strip: the data is never written into the output at all —
      // nothing for a bundler's DCE to depend on, and nothing shipped for the
      // no-bundler tsc/ts-patch path either. The getters still exist so
      // `container._graph`/`_dependencyGraph` stay defined (never `undefined`).
      return `// Debug data stripped at build time (see the plugin's \`debug\` option)
  public get _graph() { return []; }
  public get _dependencyGraph() { return []; }`;
    }

    const edges: Array<{ token: string; dependencies: string[]; multi?: true }> = [];
    for (const [tokenId, node] of graph.nodes) {
      edges.push({ token: tokenId, dependencies: node.dependencies });
    }
    if (graph.multiNodes) {
      for (const [tokenId, nodes] of graph.multiNodes) {
        for (const node of nodes) {
          edges.push({ token: tokenId, dependencies: node.dependencies, multi: true });
        }
      }
    }

    return `// For debugging/inspection — token IDs are stripped by DCE in production
  public get _graph() {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return [];
    return ${JSON.stringify(Array.from(graph.nodes.keys()))};
  }

  // Same token list as _graph, but with each token's own dependency edges —
  // enough to render an actual dependency graph (e.g. as DOT or mermaid)
  // instead of just a flat list. Stripped by DCE in production, same as _graph.
  public get _dependencyGraph() {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return [];
    return ${JSON.stringify(edges)};
  }`;
  }
}

/** Scope and lifecycle fields shared by both emitters. */
function containerState(
  graph: DependencyGraph,
  hasAsync: boolean,
  eagerLines: string[],
  minimal = false,
): { stateFields: string; eagerField: string } {
  const borrowedList = borrowedSeeds(graph).join(', ');
  const scopeFields = `private _closed = false;
  private _borrowed = new Set<unknown>([${borrowedList}]);
  private _destroyWork?: Promise<void>;`;
  const eagerField = !hasAsync && eagerLines.length > 0 ? '\n  private _eagerOnce = false;' : '';
  const stateFields = hasAsync
    ? `private _state: 'created' | 'initializing' ${minimal ? '' : "| 'reconfiguring' "}| 'ready' | 'failed' | 'destroying' | 'destroyed' = 'created';
  private _initWork?: Promise<void>;
  private _failure: unknown;
  private _initRunning = false;
  private _initJournal: unknown[] = [];
  ${scopeFields}
  private _syncInit = 0;`
    : `${minimal ? '' : 'private _reconfiguring = false;\n  '}private _failure?: unknown;
  ${scopeFields}`;
  return { stateFields, eagerField };
}

/** Leading text of every generated container. Empty: the container imports nothing from Node. */
function generatedContainerHeader(): string {
  return '';
}

function runtimeHelpers(hasAsync: boolean): string {
  return `${touchClosedMethod()}

  ${assertParentsMethod()}
  ${hasAsync ? '' : syncNeoFailMethod()}`;
}

/** Exported root sets and their guard. Closed mode only. ADR006 lines 29-33. */
function rootMembers(
  graph: DependencyGraph,
  closed: boolean,
  getImport: GetImport,
): { rootFields: string; assertRootMethod: string } {
  const exported = closed ? exportedRootIds(graph) : undefined;
  const rootFields = exported
    ? `\n  private _singleRoots = new Set<unknown>([${rootKeyExprs(exported.single, graph, getImport)}]);\n  private _multiRoots = new Set<unknown>([${rootKeyExprs(exported.multi, graph, getImport)}]);`
    : '';
  const assertRootMethod = closed ? `

  private _assertRoot(token: unknown, all: boolean): void {
    if ((all ? this._multiRoots : this._singleRoots).has(token)) return;
    const error = new Error('NEO_ROOT_NOT_EXPORTED: [' + this.name + '] token is not an exported root') as Error & { code: string };
    error.code = 'NEO_ROOT_NOT_EXPORTED';
    throw error;
  }` : '';
  return { rootFields, assertRootMethod };
}

function visitServices(graph: DependencyGraph, visit: (node: DependencyNode) => void): void {
  for (const node of graph.nodes.values()) visit(node);
  if (!graph.multiNodes) return;
  for (const nodes of graph.multiNodes.values()) nodes.forEach(visit);
}

/**
 * The graph with the reads of a copied factory bound. A factory written in another file (a partial reached
 * through `extends`) is copied into the container's file, where the names its text reads mean nothing: each
 * read of a name its own file binds becomes a member of a namespace import of the module that exports it
 * (`new Remote()` is `new __neo_Import_0.Remote()`). A rewrite the plugin already made keeps its range:
 * the two never edit the same text. An import is registered only for a read that is kept.
 *
 * - A name the container's own file exports is read by the name that file gives it (`Tag`): the file never
 *   imports itself.
 * - A name read only in type positions is imported with `import type`: the copy adds no runtime dependency.
 */
function withBindingRewrites(
  graph: DependencyGraph,
  containerFile: string | undefined,
  namespaceOf: (filePath: string) => string,
  typeAliasOf: (file: string, exportName: string | undefined, preferred: string) => string,
): DependencyGraph {
  let changed = false;
  const bound = (node: DependencyNode): DependencyNode => {
    const { factoryBindings, factoryOrigin, factoryRewrites } = node.service;
    if (!factoryBindings || !factoryOrigin || normalizeFile(factoryOrigin.file) === containerFile) return node;
    const plugin = factoryRewrites ?? [];
    const free: SourceRewrite[] = [];
    for (const binding of factoryBindings) {
      const kept = binding.ranges.filter((range) =>
        range.start >= factoryOrigin.start
        && range.end <= factoryOrigin.start + factoryOrigin.length
        && !plugin.some((other) => range.start < other.end && other.start < range.end));
      if (kept.length === 0) continue;
      // What stands where the name was read.
      const own = containerFile !== undefined && normalizeFile(binding.file) === containerFile ? binding.localName : undefined;
      let member: string;
      if (own !== undefined) {
        member = own;
      } else if (kept.every((range) => range.type === true)) {
        member = typeAliasOf(binding.file, binding.exportName, binding.exportName ?? 'Module');
      } else {
        const reads = namespaceOf(binding.file);
        member = binding.exportName === undefined ? reads : `${reads}.${binding.exportName}`;
      }
      for (const range of kept) {
        // `{ Remote }` is `{ Remote: ns.Remote }`: a member access cannot stand where a shorthand name stands.
        const text = range.shorthand === undefined ? member : `${range.shorthand}: ${member}`;
        free.push({ start: range.start, end: range.end, text });
      }
    }
    if (free.length === 0) return node;
    changed = true;
    const rewrites = [...plugin, ...free].sort((left, right) => left.start - right.start || left.end - right.end);
    return { ...node, service: { ...node.service, factoryRewrites: rewrites } };
  };
  const nodes = new Map<TokenId, DependencyNode>();
  for (const [tokenId, node] of graph.nodes) nodes.set(tokenId, bound(node));
  let multiNodes = graph.multiNodes;
  if (graph.multiNodes) {
    multiNodes = new Map();
    for (const [tokenId, list] of graph.multiNodes) multiNodes.set(tokenId, list.map(bound));
  }
  return changed ? { ...graph, nodes, multiNodes } : graph;
}

/**
 * Direct useValue consts. Partial captures are property reads and stay at `new`. A const the registration's
 * declared type is known for is annotated with it, so the expression keeps the contextual type it had in the
 * user's file (`{ kind: 'a' }` stays assignable to `{ kind: 'a' | 'b' }`).
 */
function captureHoists(graph: DependencyGraph, copy: UserCopy, types: ReadonlyMap<string, string>): Fragment[] {
  const lines: Fragment[] = [];
  visitServices(graph, (node) => {
    const name = node.service.valueCapture;
    const expr = node.service.valueSource;
    if (!name || !expr || node.service.valueCaptureRead) return;
    const type = types.get(name);
    const annotation = type === undefined ? '' : `: ${type}`;
    lines.push(fragment`const ${name}${annotation} = ${concat(copy(expr, node.service.valueOrigin, node.service.valueRewrites))};`);
  });
  return lines;
}

function borrowedSeeds(graph: DependencyGraph): string[] {
  const seeds: string[] = [];
  visitServices(graph, (node) => {
    if (node.service.type !== 'value' || !isBorrowedInstance(node.service)) return;
    if (node.service.valueCapture) seeds.push(node.service.valueCapture);
  });
  return seeds;
}

/** Absent and explicit open emit the same text. ADR006 line 9. */
function openModeMark(mode: 'open' | 'closed' | undefined): string {
  return mode === 'closed' ? '' : '';
}

function dropUnreachable(graph: DependencyGraph): DependencyGraph {
  const retention = graph.retention;
  if (!retention) return graph;
  for (const reason of retention.values()) {
    if (reason.kind === 'unreachable') return pruneClosed(graph);
  }
  return graph;
}

function pruneClosed(graph: DependencyGraph): DependencyGraph {
  const nodes = new Map<TokenId, DependencyNode>();
  for (const [tokenId, node] of graph.nodes) {
    if (!keepRegistration(graph, node.service.registrationId ?? tokenId)) continue;
    nodes.set(tokenId, node);
  }
  let multiNodes = graph.multiNodes;
  if (graph.multiNodes) {
    multiNodes = new Map();
    for (const [tokenId, list] of graph.multiNodes) {
      const kept = list.filter((node) => keepRegistration(graph, node.service.registrationId ?? tokenId));
      if (kept.length > 0) multiNodes.set(tokenId, kept);
    }
  }
  return { ...graph, nodes, multiNodes };
}

function keepRegistration(graph: DependencyGraph, id: string): boolean {
  return graph.retention?.get(id)?.kind !== 'unreachable';
}

function residualValueReads(graph: DependencyGraph): string[] {
  const lines: string[] = [];
  visitServices(graph, (node) => {
    if (!isUnreachable(graph, node)) return;
    const capture = node.service.valueCapture;
    if (!capture || !node.service.valueCaptureRead) return;
    lines.push(`void ${capture};`);
  });
  return lines;
}

function isUnreachable(graph: DependencyGraph, node: DependencyNode): boolean {
  const id = node.service.registrationId ?? node.service.tokenId;
  return graph.retention?.get(id)?.kind === 'unreachable';
}

function eagerSyncLines(graph: DependencyGraph, getImport: GetImport, hasAsync: boolean): string[] {
  if (graph.optimizationMode !== 'closed') return [];
  const lines: string[] = [];
  const pushNode = (node: DependencyNode, factoryId: string) => {
    if (node.service.isAsync) return;
    const tokenKey = resolveTokenKey(node.service, getImport);
    if (node.service.lifecycle === 'transient') {
      lines.push(`{ this.${factoryId}(); }`);
      return;
    }
    const stored = afterStore('__neoEager', tokenKey, hasAsync, isBorrowedInstance(node.service));
    lines.push(`{ if (!this.instances.has(${tokenKey})) { const __neoEager = this.${factoryId}(); ${stored} } }`);
  };
  for (const id of graph.eagerRoots ?? []) {
    const node = graph.nodes.get(id);
    if (node) pushNode(node, getFactoryName(id));
    graph.multiNodes?.get(id)?.forEach((item, index) => {
      pushNode(item, `${getFactoryName(id)}_${index}`);
    });
  }
  return lines;
}

function rootKeyExprs(ids: readonly TokenId[], graph: DependencyGraph, getImport: GetImport): string {
  return ids.map((id) => {
    const node = graph.nodes.get(id) ?? graph.multiNodes?.get(id)?.[0];
    return node ? resolveTokenKey(node.service, getImport) : JSON.stringify(id);
  }).join(', ');
}

function loadEffectFiles(graph: DependencyGraph): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  visitServices(graph, (node) => {
    if (!isUnreachable(graph, node)) return;
    const symbol = node.service.implementationSymbol ?? node.service.tokenSymbol;
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return;
    const file = declaration.getSourceFile();
    // A .d.ts is not executed. Importing it (and stripping .ts) yields a specifier no bundler resolves.
    if (file.isDeclarationFile) return;
    const name = file.fileName.replace(/\\/g, '/');
    if (seen.has(name)) return;
    const host = graph.sourceFileName?.replace(/\\/g, '/');
    if (host && name === host) return;
    if (!hasTopLevelEffect(file)) return;
    seen.add(name);
    files.push(file.fileName);
  });
  return files;
}

function hasTopLevelEffect(file: ts.SourceFile): boolean {
  for (const statement of file.statements) {
    if (pureTopLevel(statement)) continue;
    return true;
  }
  return false;
}

/** A load-time effect is anything that is not a pure declaration. ADR006 lines 35-38. */
function pureTopLevel(statement: ts.Statement): boolean {
  if (TSContext.ts.isInterfaceDeclaration(statement)) return true;
  if (TSContext.ts.isTypeAliasDeclaration(statement)) return true;
  if (TSContext.ts.isFunctionDeclaration(statement)) return true;
  if (TSContext.ts.isImportDeclaration(statement)) return importIsTypeOnly(statement);
  if (TSContext.ts.isExportDeclaration(statement)) return exportIsTypeOnly(statement);
  if (TSContext.ts.isClassDeclaration(statement)) return !classRunsAtLoad(statement);
  return false;
}

function importIsTypeOnly(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause || clause.name) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  if (!named || !TSContext.ts.isNamedImports(named)) return false;
  return named.elements.length > 0 && named.elements.every((element) => element.isTypeOnly);
}

function exportIsTypeOnly(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return true;
  const clause = statement.exportClause;
  if (!clause || !TSContext.ts.isNamedExports(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

function classRunsAtLoad(statement: ts.ClassDeclaration): boolean {
  if (decorated(statement)) return true;
  if (definitionRunsAtLoad(statement)) return true;
  for (const member of statement.members) {
    if (decorated(member)) return true;
    if (TSContext.ts.isClassStaticBlockDeclaration(member)) return true;
    if (!TSContext.ts.isPropertyDeclaration(member) || !member.initializer) continue;
    const flags = TSContext.ts.getCombinedModifierFlags(member);
    if ((flags & TSContext.ts.ModifierFlags.Static) !== 0) return true;
  }
  return false;
}

/** A heritage call, a non-literal computed name, or a parameter decorator runs when the class is defined. */
function definitionRunsAtLoad(statement: ts.ClassDeclaration): boolean {
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token !== TSContext.ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeNode of clause.types) {
      if (!heritageIsStable(typeNode.expression)) return true;
    }
  }
  for (const member of statement.members) {
    if (TSContext.ts.isConstructorDeclaration(member)) {
      if (member.parameters.some((parameter) => decorated(parameter))) return true;
      continue;
    }
    const name = namedMember(member);
    if (name && computedNameRuns(name)) return true;
  }
  return false;
}

function heritageIsStable(expression: ts.Expression): boolean {
  if (TSContext.ts.isIdentifier(expression)) return true;
  if (!TSContext.ts.isPropertyAccessExpression(expression)) return false;
  return heritageIsStable(expression.expression);
}

function namedMember(member: ts.ClassElement): ts.PropertyName | undefined {
  if (
    TSContext.ts.isPropertyDeclaration(member)
    || TSContext.ts.isMethodDeclaration(member)
    || TSContext.ts.isGetAccessorDeclaration(member)
    || TSContext.ts.isSetAccessorDeclaration(member)
  ) {
    return member.name;
  }
  return undefined;
}

function computedNameRuns(name: ts.PropertyName): boolean {
  if (!TSContext.ts.isComputedPropertyName(name)) return false;
  const expression = name.expression;
  if (TSContext.ts.isStringLiteral(expression)) return false;
  if (TSContext.ts.isNumericLiteral(expression)) return false;
  if (TSContext.ts.isNoSubstitutionTemplateLiteral(expression)) return false;
  return true;
}

function decorated(node: ts.Node): boolean {
  if (!TSContext.ts.canHaveDecorators(node)) return false;
  return (TSContext.ts.getDecorators(node)?.length ?? 0) > 0;
}
