import type * as ts from 'typescript';
import { relative, isAbsolute, dirname } from 'node:path';
import { DependencyGraph, DependencyNode, TokenId } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';
import { topologicalSort } from './TopologicalSorter';
import { generateFactories, generateMultiFactories, getFactoryName, resolveTokenKey, type GetImport } from './FactoryEmitter';
import { generateResolveCases, generateResolveAllMethod, generateMultiResolveGuard, buildAsyncResolveGuard, parentOpenCheck, isBorrowedInstance, afterStore } from './ResolveEmitter';
import { hasAsyncFactories, generateInitializeMethod, generateSyncInitializeMethod, generateEagerSyncInitialize, generateDestroyMethod, generateCreateScopeMethod, generateOverrideMethods, touchClosedMethod, assertParentsMethod, syncNeoFailMethod } from './LifecycleEmitter';
import { exportedRootIds } from '../analyzer/parsers/ConfigParser';
import { TSContext } from '../TSContext';
import { HashUtils } from '../analyzer/shared/HashUtils';

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
    private testOverrides: boolean = false
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
    // keep names stable there for backward compatibility.
    const suffix = this.useDirectSymbolNames ? `_${this.getGeneratedClassSuffix()}` : '';
    this.containerClassName = `NeoContainer${suffix}`;
    this.notFoundErrorClassName = `NeoServiceNotFoundError${suffix}`;
  }

  /**
   * Computes a short, deterministic, per-call-site hash used to uniquify the
   * generated class names (see constructor). Prefers the source file + AST
   * position of the `defineBuilderConfig` call (unique per call site); falls
   * back to `containerId` when positions aren't available (e.g. hand-built
   * graphs in unit tests).
   */
  private getGeneratedClassSuffix(): string {
    const key = this.graph.sourceFileName !== undefined && this.graph.defineBuilderConfigStart !== undefined
      ? `${this.graph.sourceFileName}:${this.graph.defineBuilderConfigStart}`
      : this.graph.containerId;
    return HashUtils.hashString(key);
  }

  /**
   * Generates the complete container code as a string.
   * @returns TypeScript source code for the generated container.
   */
  public generate(): string {
    const sourceGraph = this.graph;
    const emitted = dropUnreachable(sourceGraph);
    const sorted = topologicalSort(emitted.nodes);
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
    for (const node of emitted.nodes.values()) indexLocalNames(node);
    if (emitted.multiNodes) {
      for (const nodes of emitted.multiNodes.values()) nodes.forEach(indexLocalNames);
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
            imports.set(filePath, `__neo_Import_${imports.size}`);
          }
        }
      }
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
        // Named exports: direct identifier is stable — bundlers correctly rename all references.
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
        imports.set(filePath, `Import_${imports.size}`);
      }
      return `${imports.get(filePath)}.${symbol.getName()}`;
    };

    // Like getImport, but always emits an explicit namespace import — used only
    // for a parent-provided class token (see FactoryEmitter.resolveConstructorArgs).
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
      const filePath = decl.getSourceFile().fileName;
      const prefix = this.useDirectSymbolNames ? '__neo_Import_' : 'Import_';
      if (!imports.has(filePath)) {
        imports.set(filePath, `${prefix}${imports.size}`);
      }
      return `${imports.get(filePath)}.${symbol.getName()}`;
    };

    // A container with no async factories of its own still needs initialize()
    // (and the guard below) if its useContainer parent/legacy chain has them —
    // otherwise resolving from this container before the parent is ready would
    // silently succeed for local tokens and only fail deep inside the parent's
    // own resolve(), with no guidance that it's an initialization-order issue.
    const hasAsync = hasAsyncFactories(emitted) || !!emitted.parentHasAsyncInitialize;
    const closed = emitted.optimizationMode === 'closed';
    const resolveGuard = buildAsyncResolveGuard(hasAsync);
    const eagerLines = eagerSyncLines(emitted, getImport, hasAsync);

    const factories = generateFactories(emitted, sorted, getImport, getForeignImport, hasAsync, closed);
    const resolveCases = generateResolveCases(
      emitted,
      sorted,
      getImport,
      hasAsync,
      `${this.containerClassName}.formatToken`,
    );
    const multiFactories = generateMultiFactories(emitted, getImport, getForeignImport, hasAsync, closed);
    const resolveAllMethod = generateResolveAllMethod(emitted, getImport, hasAsync, closed);
    const initializeMethod = hasAsync
      ? generateInitializeMethod(emitted, sorted, getImport, hasAsync, eagerLines)
      : eagerLines.length > 0
        ? generateEagerSyncInitialize(eagerLines)
        : generateSyncInitializeMethod();
    const createScopeMethod = generateCreateScopeMethod(this.containerClassName, hasAsync);
    const destroyMethod = generateDestroyMethod(emitted, sorted, getImport, hasAsync);
    const overrideMethods = generateOverrideMethods(emitted, sorted, getImport, hasAsync, this.testOverrides);

    // Generate import lines for:
    // - All symbols when useDirectSymbolNames=false (CLI/generated file mode)
    // - Only default export symbols when useDirectSymbolNames=true (inline transform mode)
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
    // A pruned provider's module still runs when it has a top-level effect. ADR006 lines 35-38.
    for (const filePath of loadEffectFiles(sourceGraph)) {
      if (imports.has(filePath)) continue;
      importLines.push(`import '${specifierFor(filePath)}';`);
    }

    const borrowedList = borrowedSeeds(emitted).join(', ');
    // A successful legacy resolve borrows that instance. A throw must not mark the caller's own result.
    const borrowField = '';
    const borrowReset = '';
    const borrowBefore = `const legacyResult = legacyContainer.resolve(token);
                    if (legacyResult != null) this._borrowed.add(legacyResult);`;
    const borrowNotify = '';
    const scopeFields = `private _closed = false;
  ${borrowField}private _borrowed = new Set<any>([${borrowedList}]);
  private _destroyWork?: Promise<void>;`;
    const eagerField = !hasAsync && eagerLines.length > 0 ? '\n  private _eagerOnce = false;' : '';
    const stateFields = hasAsync
      ? `private _state: 'created' | 'initializing' | 'reconfiguring' | 'ready' | 'failed' | 'destroying' | 'destroyed' = 'created';
  private _initWork?: Promise<void>;
  private _failure: unknown;
  private _initRunning = false;
  private _initJournal: any[] = [];
  ${scopeFields}`
      : `private _reconfiguring = false;
  private _failure?: unknown;
  ${scopeFields}`;
    const runtimeHelpers = `${touchClosedMethod()}

  ${assertParentsMethod()}
  ${hasAsync ? '' : syncNeoFailMethod()}`;
    const captureLines = captureHoists(sourceGraph);
    for (const line of residualValueReads(sourceGraph)) captureLines.push(line);

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
    if (result !== undefined) {
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
            } catch (e: any) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${this.notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${this.containerClassName}.formatToken(token)}\`);`;

    const resolveMethod = hasAsync
      ? `public resolve<T>(token: any): T {
    this._guardPublic();
    ${closed ? assertOne + '\n    ' : ''}return this._resolveInternal<T>(token);
  }

  private _resolveInternal<T>(token: any): T {${resolveInterior}
  }`
      : closed
        ? `public resolve<T>(token: any): T {
    ${assertOne}
    return this._resolveInternal<T>(token);
  }

  private _resolveInternal<T>(token: any): T {${resolveInterior}
  }`
        : `public resolve<T>(token: any): T {
    ${resolveGuard}${resolveInterior}
  }`;

    const exported = closed ? exportedRootIds(emitted) : undefined;
    const rootFields = exported
      ? `\n  private _singleRoots = new Set<any>([${rootKeyExprs(exported.single, emitted, getImport)}]);\n  private _multiRoots = new Set<any>([${rootKeyExprs(exported.multi, emitted, getImport)}]);`
      : '';
    const assertRootMethod = closed ? `

  private _assertRoot(token: any, all: boolean): void {
    if ((all ? this._multiRoots : this._singleRoots).has(token)) return;
    const error = new Error('NEO_ROOT_NOT_EXPORTED: [' + this.name + '] token is not an exported root') as Error & { code: string };
    error.code = 'NEO_ROOT_NOT_EXPORTED';
    throw error;
  }` : '';

    return `${openModeMark(sourceGraph.optimizationMode)}
${importLines.join('\n')}
${captureLines.join('\n')}

class ${this.notFoundErrorClassName} extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class ${this.containerClassName} {
  private instances = new Map<any, any>();
  private overrides = new Map<any, () => any>();
  private resolveListeners = new Set<(token: any, instance: any) => void>();
  ${stateFields}${eagerField}${rootFields}

  // -- Factories --
  ${[...factories, ...multiFactories].join('\n  ')}

  constructor(
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  ${runtimeHelpers}${assertRootMethod}

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
  public on(event: 'resolve', listener: (token: any, instance: any) => void): () => void {
    this.resolveListeners.add(listener);
    return () => { this.resolveListeners.delete(listener); };
  }

  private notifyResolve(token: any, instance: any): void {
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
  private static formatToken(token: any): string {
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

  private resolveLocal(token: any): any {
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

function visitServices(graph: DependencyGraph, visit: (node: DependencyNode) => void): void {
  for (const node of graph.nodes.values()) visit(node);
  if (!graph.multiNodes) return;
  for (const nodes of graph.multiNodes.values()) nodes.forEach(visit);
}

/** Direct useValue consts. Partial captures are property reads and stay at `new`. */
function captureHoists(graph: DependencyGraph): string[] {
  const lines: string[] = [];
  visitServices(graph, (node) => {
    const name = node.service.valueCapture;
    const expr = node.service.valueSource;
    if (!name || !expr || !name.startsWith('__neoCapture_')) return;
    lines.push(`const ${name} = ${expr};`);
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
    if (!capture || capture.startsWith('__neoCapture_')) return;
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
