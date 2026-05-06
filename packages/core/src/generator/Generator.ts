import type * as ts from 'typescript';
import { relative, isAbsolute } from 'node:path';
import { DependencyGraph } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';
import { topologicalSort } from './TopologicalSorter';
import { generateFactories, generateMultiFactories, type GetImport } from './FactoryEmitter';
import { generateResolveCases, generateResolveAllMethod } from './ResolveEmitter';
import { hasAsyncFactories, generateInitializeMethod, generateDestroyMethod } from './LifecycleEmitter';

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

    const getImport: GetImport = (symbol: ts.Symbol): string => {
      if (this.useDirectSymbolNames) {
        return symbol.getName();
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
    const resolveGuard = hasAsync
      ? `if (!this._initialized) { throw new Error(\`[\${this.name}] This container has async services — call \\\`await container.initialize()\\\` before the first resolve().\`); }`
      : '';

    const factories = generateFactories(this.graph, sorted, getImport);
    const resolveCases = generateResolveCases(this.graph, sorted, getImport);
    const multiFactories = generateMultiFactories(this.graph, getImport);
    const resolveAllMethod = generateResolveAllMethod(this.graph, getImport, resolveGuard);
    const initializeMethod = hasAsync ? generateInitializeMethod(this.graph, sorted) : '';
    const destroyMethod = generateDestroyMethod(this.graph, sorted, getImport);

    const importLines: string[] = [];
    if (!this.useDirectSymbolNames) {
      const base = this.outputDir ?? process.cwd();
      for (const [filePath, alias] of imports) {
        let importPath: string;
        if (isAbsolute(filePath)) {
          const rel = relative(base, filePath).replace(/\\/g, '/');
          importPath = rel.startsWith('.') ? rel : `./${rel}`;
        } else {
          importPath = filePath;
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
   * The getter is always present in the generated code. In production
   * (`NODE_ENV === 'production'`), it returns an empty array at runtime
   * so token IDs are not exposed. Bundlers with dead-code elimination
   * will strip the branch entirely when NODE_ENV is statically known.
   */
  private emitDebugGetter(): string {
    return `// For debugging/inspection — omitted in production
  public get _graph() {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return [];
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
  }`;
  }
}
