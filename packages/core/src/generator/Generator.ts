import type * as ts from 'typescript';
import { TSContext } from '../TSContext';
import { DependencyGraph, TokenId } from '../analyzer/types';
import { DuplicateRegistrationError, TypeMismatchError } from '../analyzer/Analyzer';

/**
 * Generates TypeScript code for the dependency injection container.
 *
 * Takes a validated dependency graph and produces:
 * - Import statements for all dependencies
 * - Factory functions for each service
 * - A NeoContainer class with resolve logic
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
   */
  constructor(private graph: DependencyGraph, private useDirectSymbolNames: boolean = false) {
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
    const sorted = this.topologicalSort();
    const imports = new Map<string, string>(); // filePath -> importAliasPrefix

    const getImport = (symbol: ts.Symbol): string => {
      if (this.useDirectSymbolNames) {
        return symbol.getName();
      }
      const decl = symbol.declarations?.[0];
      if (!decl) return 'UNKNOWN';
      const filePath = decl.getSourceFile().fileName;
      if (!imports.has(filePath)) {
        imports.set(filePath, `Import_${imports.size}`);
      }
      return `${imports.get(filePath)}.${symbol.getName()}`;
    };

    const factories = this.generateFactories(sorted, getImport);
    const resolveCases = this.generateResolveCases(sorted, getImport);
    const multiFactories = this.generateMultiFactories(getImport);
    const resolveAllMethod = this.generateResolveAllMethod(getImport);
    const hasAsync = this.hasAsyncFactories();
    const initializeMethod = hasAsync ? this.generateInitializeMethod(sorted) : '';

    const importLines: string[] = [];
    if (!this.useDirectSymbolNames) {
      for (const [filePath, alias] of imports) {
        importLines.push(`import * as ${alias} from '${filePath}';`);
      }
    }

    const initializedField = hasAsync ? `private _initialized = false;` : '';
    const resolveGuard = hasAsync
      ? `if (!this._initialized) { throw new Error(\`[\${this.name}] This container has async services — call \\\`await container.initialize()\\\` before the first resolve().\`); }`
      : '';
    const destroyReset = hasAsync ? `this._initialized = false;` : '';

    return `
${importLines.join('\n')}

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
            // Only fall through for "not found" — let real errors bubble
            if (!e?.message?.includes('Service not found or token not registered')) throw e;
        }
    }

    // 3. Delegate to legacy
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) return legacyContainer.resolve(token);
            } catch (e: any) {
                if (!e?.message?.includes('Service not found or token not registered')) throw e;
            }
        }
    }

    throw new Error(\`[\${this.name}] Service not found or token not registered: \${token}\`);
  }

  public destroy(): void {
    ${destroyReset}
    this.instances.clear();
  }

  ${resolveAllMethod}

  private resolveLocal(token: any): any {
    ${resolveCases.join('\n    ')}
    return undefined;
  }

  // For debugging/inspection
  public get _graph() {
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
  }
}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
  }

  /**
   * Generates only the instantiation expression: new NeoContainer(...)
   * This is used to replace defineBuilderConfig(...) in the source.
   */
  public generateInstantiation(): string {
    const buildArgs = (this.graph.buildArguments && this.graph.buildArguments.length > 0) ? this.graph.buildArguments[0] : 'undefined';
    const legacyArgs = this.graph.legacyContainers ? `[${this.graph.legacyContainers.join(', ')}]` : 'undefined';
    const nameArg = this.graph.containerName ? JSON.stringify(this.graph.containerName) : 'undefined';
    return `new NeoContainer(${buildArgs}, ${legacyArgs}, ${nameArg})`;
  }

  // ---------------------------------------------------------------------------
  // Private generation helpers
  // ---------------------------------------------------------------------------

  /** Generates a factory method for each service in topological order. */
  private generateFactories(sorted: TokenId[], getImport: (s: ts.Symbol) => string): string[] {
    const factories: string[] = [];

    for (const tokenId of sorted) {
      const node = this.graph.nodes.get(tokenId);
      if (!node) continue;
      if (node.service.type === 'parent') continue;

      const factoryId = this.getFactoryName(tokenId);

      if (node.service.type === 'value' && node.service.valueSource !== undefined) {
        // Value provider: embed the source expression directly
        factories.push(`
  private ${factoryId}(): any {
    return ${node.service.valueSource};
  }`);
        continue;
      }

      if (node.service.type === 'factory' && node.service.factorySource) {
        const userFactory = node.service.factorySource;
        factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${userFactory};
    return userFactory(this);
  }`);
      } else {
        if (!node.service.implementationSymbol) {
          throw new Error(
            `[Generator] No implementation symbol for token '${tokenId}'. ` +
            `This is likely a bug — ensure all non-factory registrations have a provider class.`
          );
        }
        const className = getImport(node.service.implementationSymbol);
        const args = this.resolveConstructorArgs(node.dependencies, getImport);

        factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }
    }

    return factories;
  }

  /** Resolves constructor argument expressions for a list of dependency token IDs. */
  private resolveConstructorArgs(dependencies: TokenId[], getImport: (s: ts.Symbol) => string): string {
    return dependencies.map(depId => {
      const depNode = this.graph.nodes.get(depId);
      if (!depNode) return 'undefined';

      if (depNode.service.isInterfaceToken) {
        return `this.resolve("${depNode.service.tokenId}")`;
      } else if (depNode.service.tokenSymbol) {
        return `this.resolve(${getImport(depNode.service.tokenSymbol)})`;
      } else if (depNode.service.implementationSymbol) {
        return `this.resolve(${getImport(depNode.service.implementationSymbol)})`;
      }
      return 'undefined';
    }).join(', ');
  }

  /** Generates resolve switch cases for each service in topological order. */
  private generateResolveCases(sorted: TokenId[], getImport: (s: ts.Symbol) => string): string[] {
    const resolveCases: string[] = [];

    for (const tokenId of sorted) {
      const node = this.graph.nodes.get(tokenId);
      if (!node) continue;
      if (node.service.type === 'parent') continue;

      const factoryId = this.getFactoryName(tokenId);
      const isTransient = node.service.lifecycle === 'transient';

      let tokenKey: string;
      let tokenCheck: string;

      if (node.service.isInterfaceToken) {
        tokenKey = `"${node.service.tokenId}"`;
        tokenCheck = `if (token === "${node.service.tokenId}")`;
      } else if (node.service.tokenSymbol) {
        const tokenClass = getImport(node.service.tokenSymbol);
        tokenKey = tokenClass;
        tokenCheck = `if (token === ${tokenClass})`;
      } else if (node.service.implementationSymbol) {
        const className = getImport(node.service.implementationSymbol);
        tokenKey = className;
        tokenCheck = `if (token === ${className})`;
      } else {
        tokenKey = `"${node.service.tokenId}"`;
        tokenCheck = `if (token === "${node.service.tokenId}")`;
      }

      const creationLogic = isTransient
        ? `return this.${factoryId}();`
        : `
            if (!this.instances.has(${tokenKey})) {
                const instance = this.${factoryId}();
                this.instances.set(${tokenKey}, instance);
                return instance;
            }
            return this.instances.get(${tokenKey});
          `;

      resolveCases.push(`${tokenCheck} { ${creationLogic} }`);
    }

    return resolveCases;
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
   * Sorts services in topological order (dependencies before dependents).
   * @returns Array of TokenIds in dependency order.
   */
  private topologicalSort(): TokenId[] {
    const visited = new Set<TokenId>();
    const sorted: TokenId[] = [];

    const visit = (id: TokenId) => {
      if (visited.has(id)) return;
      visited.add(id);
      const node = this.graph.nodes.get(id);
      if (node) {
        for (const depId of node.dependencies) {
          visit(depId);
        }
        sorted.push(id);
      }
    };

    for (const id of this.graph.nodes.keys()) {
      visit(id);
    }

    return sorted;
  }

  /**
   * Creates a valid JavaScript function name from a token ID.
   * @param tokenId - The token identifier.
   * @returns A sanitized factory function name.
   */
  private getFactoryName(tokenId: TokenId): string {
    return `create_${tokenId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }

  /** Returns true if any node in the graph has an async factory. */
  private hasAsyncFactories(): boolean {
    for (const node of this.graph.nodes.values()) {
      if (node.service.isAsync) return true;
    }
    return false;
  }

  /**
   * Generates the initialize() method that pre-creates all async singleton factories
   * in topological order. Only called when hasAsyncFactories() is true.
   */
  private generateInitializeMethod(sorted: TokenId[]): string {
    const asyncSingletons = sorted.filter(tokenId => {
      const node = this.graph.nodes.get(tokenId);
      return node?.service.isAsync && node.service.lifecycle === 'singleton';
    });

    const lines = asyncSingletons.map(tokenId => {
      const factoryId = this.getFactoryName(tokenId);
      return `this.instances.set("${tokenId}", await this.${factoryId}());`;
    });

    return `public async initialize(): Promise<void> {
    if (this._initialized) return;
    ${lines.join('\n    ')}
    this._initialized = true;
  }`;
  }

  /** Generates indexed factory methods for multi-registration nodes. */
  private generateMultiFactories(getImport: (s: ts.Symbol) => string): string[] {
    const factories: string[] = [];
    if (!this.graph.multiNodes) return factories;

    for (const [tokenId, nodes] of this.graph.multiNodes) {
      nodes.forEach((node, index) => {
        const factoryId = `${this.getFactoryName(tokenId)}_${index}`;

        if (node.service.type === 'factory' && node.service.factorySource) {
          factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${node.service.factorySource};
    return userFactory(this);
  }`);
        } else if (node.service.type === 'value' && node.service.valueSource !== undefined) {
          factories.push(`
  private ${factoryId}(): any {
    return ${node.service.valueSource};
  }`);
        } else {
          if (!node.service.implementationSymbol) return;
          const className = getImport(node.service.implementationSymbol);
          const args = this.resolveConstructorArgs(node.dependencies, getImport);
          factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
        }
      });
    }

    return factories;
  }

  /** Generates the resolveAll() method with one branch per multi-token. */
  private generateResolveAllMethod(getImport: (s: ts.Symbol) => string): string {
    if (!this.graph.multiNodes || this.graph.multiNodes.size === 0) {
      return `public resolveAll<T>(token: any): T[] { return []; }`;
    }

    const cases: string[] = [];

    for (const [tokenId, nodes] of this.graph.multiNodes) {
      const firstNode = nodes[0];
      let tokenCheck: string;

      if (firstNode.service.isInterfaceToken) {
        tokenCheck = `if (token === "${firstNode.service.tokenId}")`;
      } else if (firstNode.service.tokenSymbol) {
        tokenCheck = `if (token === ${getImport(firstNode.service.tokenSymbol)})`;
      } else {
        tokenCheck = `if (token === "${firstNode.service.tokenId}")`;
      }

      const isTransient = firstNode.service.lifecycle === 'transient';
      const factoryBase = this.getFactoryName(tokenId);

      let callExprs: string[];
      if (isTransient) {
        callExprs = nodes.map((_, i) => `this.${factoryBase}_${i}()`);
      } else {
        callExprs = nodes.map((_, i) => {
          const cacheKey = `"${tokenId}:${i}"`;
          return `(() => { const k = ${cacheKey}; if (!this.instances.has(k)) { const inst = this.${factoryBase}_${i}(); this.instances.set(k, inst); return inst; } return this.instances.get(k); })()`;
        });
      }

      cases.push(`${tokenCheck} return [${callExprs.join(', ')}] as T[];`);
    }

    return `public resolveAll<T>(token: any): T[] {
    ${cases.join('\n    ')}
    return [];
  }`;
  }
}
