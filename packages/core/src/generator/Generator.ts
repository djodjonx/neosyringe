import type * as ts from 'typescript';
import { relative, isAbsolute, dirname } from 'node:path';
import { DependencyGraph, DependencyNode } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';
import { topologicalSort } from './TopologicalSorter';
import { generateFactories, generateMultiFactories, type GetImport } from './FactoryEmitter';
import { generateResolveCases, generateResolveAllMethod, buildAsyncResolveGuard } from './ResolveEmitter';
import { hasAsyncFactories, generateInitializeMethod, generateDestroyMethod } from './LifecycleEmitter';
import { TSContext } from '../TSContext';

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
    private outputDir?: string
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

    const hasAsync = hasAsyncFactories(this.graph);
    const resolveGuard = buildAsyncResolveGuard(hasAsync);

    const factories = generateFactories(this.graph, sorted, getImport);
    const resolveCases = generateResolveCases(this.graph, sorted, getImport);
    const multiFactories = generateMultiFactories(this.graph, getImport);
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

class NeoServiceNotFoundError extends Error {
  constructor(msg: string) { super(msg); this.name = 'NeoServiceNotFoundError'; }
}

// -- Container --
class NeoContainer {
  private instances = new Map<any, any>();
  ${initializedField}

  // -- Factories --
  ${[...factories, ...multiFactories].join('\n  ')}

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  ${initializeMethod}

  public resolve<T>(token: any): T {
    ${resolveGuard}
    // 1. Try to resolve locally (or create if singleton)
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    // 2. Delegate to parent
    if (this.parent) {
        try {
            return this.parent.resolve(token);
        } catch (e: any) {
            // Only fall through for "not found" — let real errors bubble.
            // Use e.name instead of instanceof to support cross-file generated containers.
            if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
        }
    }

    // 3. Delegate to legacy
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) return legacyContainer.resolve(token);
            } catch (e: any) {
                if (!(e instanceof Error && e.name === 'NeoServiceNotFoundError')) throw e;
            }
        }
    }

    throw new NeoServiceNotFoundError(\`[\${this.name}] Service not found or token not registered: \${token}\`);
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
    return `new NeoContainer(undefined, ${legacyArgs}, ${nameArg})`;
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
    return `// For debugging/inspection — token IDs are stripped by DCE in production
  public get _graph() {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return [];
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
  }`;
  }
}
