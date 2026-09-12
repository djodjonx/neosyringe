import type * as ts from 'typescript';
import { relative, isAbsolute, dirname } from 'node:path';
import { DependencyGraph, DependencyNode } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';
import { topologicalSort } from './TopologicalSorter';
import { generateFactories, generateMultiFactories, type GetImport } from './FactoryEmitter';
import { generateResolveCases, generateResolveAllMethod, buildAsyncResolveGuard } from './ResolveEmitter';
import { hasAsyncFactories, generateInitializeMethod, generateDestroyMethod } from './LifecycleEmitter';
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
    private emitDebugHelpers: boolean = true
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
    const sorted = topologicalSort(this.graph.nodes);
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
    for (const node of this.graph.nodes.values()) indexLocalNames(node);
    if (this.graph.multiNodes) {
      for (const nodes of this.graph.multiNodes.values()) nodes.forEach(indexLocalNames);
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
    const hasAsync = hasAsyncFactories(this.graph) || !!this.graph.parentHasAsyncInitialize;
    const resolveGuard = buildAsyncResolveGuard(hasAsync);

    const factories = generateFactories(this.graph, sorted, getImport, getForeignImport);
    const resolveCases = generateResolveCases(this.graph, sorted, getImport);
    const multiFactories = generateMultiFactories(this.graph, getImport, getForeignImport);
    const resolveAllMethod = generateResolveAllMethod(this.graph, getImport, hasAsync);
    const initializeMethod = hasAsync ? generateInitializeMethod(this.graph, sorted) : '';
    const destroyMethod = generateDestroyMethod(this.graph, sorted, getImport);

    // Generate import lines for:
    // - All symbols when useDirectSymbolNames=false (CLI/generated file mode)
    // - Only default export symbols when useDirectSymbolNames=true (inline transform mode)
    const importLines: string[] = [];
    if (imports.size > 0) {
      // Base directory for relative import paths:
      // - useDirectSymbolNames=true: relative to the container source file (so the injected
      //   import resolves correctly from the file's perspective)
      // - useDirectSymbolNames=false: relative to the output directory (generated file)
      const base = this.useDirectSymbolNames
        ? (this.graph.sourceFileName ? dirname(this.graph.sourceFileName) : process.cwd())
        : (this.outputDir ?? process.cwd());

      for (const [filePath, alias] of imports) {
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
        importLines.push(`import * as ${alias} from '${importPath}';`);
      }
    }

    const initializedField = hasAsync ? `private _initialized = false;` : '';

    return `
${importLines.join('\n')}

class ${this.notFoundErrorClassName} extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class ${this.containerClassName} {
  private instances = new Map<any, any>();
  private overrides = new Map<any, () => any>();
  ${initializedField}

  // -- Factories --
  ${[...factories, ...multiFactories].join('\n  ')}

  constructor(
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  ${initializeMethod}

  /**
   * Replaces a token's provider for the lifetime of this container instance —
   * for tests, not production wiring. The factory runs once (its result is
   * cached like a singleton); call override() again to change it, or
   * clearOverrides() to remove all overrides and fall back to the real
   * registrations.
   *
   * Disabled when NODE_ENV=production: a container is commonly a long-lived,
   * shared singleton, so an override left in by mistake (or called from
   * somewhere it shouldn't be) would silently change what every caller gets,
   * for as long as the process runs. Throwing loudly here is cheaper than
   * debugging that at 3am.
   */
  public override(token: any, factory: () => any): void {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
      throw new Error('override() is a testing utility and is disabled when NODE_ENV=production.');
    }
    this.overrides.set(token, factory);
    this.instances.delete(token);
  }

  /** Removes all overrides set via override(), reverting to real registrations. */
  public clearOverrides(): void {
    this.overrides.clear();
  }

  public resolve<T>(token: any): T {
    ${resolveGuard}
    // 0. An overridden token always wins, even over a cached real instance.
    if (this.overrides.has(token)) {
      if (!this.instances.has(token)) {
        this.instances.set(token, this.overrides.get(token)!());
      }
      return this.instances.get(token);
    }

    // 1. Try to resolve locally (or create if singleton)
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    // 2. Delegate to parent/legacy containers (useContainer's target, whether a
    // NeoSyringe container or a declareContainerTokens() legacy adapter, always
    // ends up here)
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) return legacyContainer.resolve(token);
            } catch (e: any) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new ${this.notFoundErrorClassName}(\`[\${this.name}] Service not found or token not registered: \${${this.containerClassName}.formatToken(token)}\`);
  }

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

  ${this.emitDebugGetter()}
}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
  }

  /**
   * Generates only the instantiation expression: new NeoContainer(...)
   * This is used to replace defineBuilderConfig(...) in the source.
   */
  public generateInstantiation(): string {
    const legacyArgs = this.graph.legacyContainers ? `[${this.graph.legacyContainers.join(', ')}]` : 'undefined';
    const nameArg = this.graph.containerName ? JSON.stringify(this.graph.containerName) : 'undefined';
    return `new ${this.containerClassName}(${legacyArgs}, ${nameArg})`;
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
  private emitDebugGetter(): string {
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
    for (const [tokenId, node] of this.graph.nodes) {
      edges.push({ token: tokenId, dependencies: node.dependencies });
    }
    if (this.graph.multiNodes) {
      for (const [tokenId, nodes] of this.graph.multiNodes) {
        for (const node of nodes) {
          edges.push({ token: tokenId, dependencies: node.dependencies, multi: true });
        }
      }
    }

    return `// For debugging/inspection — token IDs are stripped by DCE in production
  public get _graph() {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return [];
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
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
