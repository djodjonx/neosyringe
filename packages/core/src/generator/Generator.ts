import * as ts from 'typescript';
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
   * @param graph - The validated dependency graph to generate code from.
   * @param useDirectSymbolNames - If true, uses symbol names directly without import prefixes.
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
    const factories: string[] = [];
    const resolveCases: string[] = [];

    // Helper to get or create import
    const getImport = (symbol: ts.Symbol): string => {
      // If using direct symbol names (for inline injection), just return the symbol name
      if (this.useDirectSymbolNames) {
        return symbol.getName();
      }

      const decl = symbol.declarations?.[0];
      if (!decl) return 'UNKNOWN';

      const sourceFile = decl.getSourceFile();
      const filePath = sourceFile.fileName;

      if (!imports.has(filePath)) {
        const alias = `Import_${imports.size}`;
        imports.set(filePath, alias);
      }

      return `${imports.get(filePath)}.${symbol.getName()}`;
    };

    // 1. Generate Factories
    for (const tokenId of sorted) {
      const node = this.graph.nodes.get(tokenId);
      if (!node) continue;

      // Skip factory generation for parent provided services
      if (node.service.type === 'parent') continue;

      const factoryId = this.getFactoryName(tokenId);

      // Handle user-defined factory functions
      if (node.service.isFactory && node.service.factorySource) {
          const userFactory = node.service.factorySource;
          factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${userFactory};
    return userFactory(this);
  }`);
      } else {
          // Standard class instantiation
          const className = node.service.implementationSymbol
              ? getImport(node.service.implementationSymbol)
              : 'undefined';

          const args = node.dependencies.map(depId => {
              const depNode = this.graph.nodes.get(depId);
              if (!depNode) {
                  return 'undefined';
              }

              if (depNode.service.isInterfaceToken) {
                  return `this.resolve("${depNode.service.tokenId}")`;
              } else if (depNode.service.tokenSymbol) {
                  const tokenClass = getImport(depNode.service.tokenSymbol);
                  return `this.resolve(${tokenClass})`;
              } else if (depNode.service.implementationSymbol) {
                 const depClass = getImport(depNode.service.implementationSymbol);
                 return `this.resolve(${depClass})`;
              }
              return 'undefined';
          }).join(', ');

          factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }

      // 2. Generate Resolve Switch Case
      const isTransient = node.service.lifecycle === 'transient';

      // Determine key for instances Map and token check
      let tokenKey: string;
      let tokenCheck: string;

      if (node.service.isInterfaceToken) {
          tokenKey = `"${node.service.tokenId}"`;
          // tokenId is now the interface name directly (e.g., "ILogger")
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
          // Factory without class - use string token
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

    // Generate Import Statements (only if not using direct symbol names)
    const importLines: string[] = [];
    if (!this.useDirectSymbolNames) {
      for (const [filePath, alias] of imports) {
          importLines.push(`import * as ${alias} from '${filePath}';`);
      }
    }


    return `
${importLines.join('\n')}

// -- Container --
class NeoContainer {
  private instances = new Map<any, any>();

  // -- Factories --
  ${factories.join('\n  ')}

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  public resolve(token: any): any {
    // 1. Try to resolve locally (or create if singleton)
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    // 2. Delegate to parent
    if (this.parent) {
        try {
            return this.parent.resolve(token);
        } catch (e) {
            // Ignore error, try legacy
        }
    }

    // 3. Delegate to legacy
    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            // Assume legacy container has resolve()
            try {
                if (legacyContainer.resolve) return legacyContainer.resolve(token);
            } catch (e) {
                // Ignore
            }
        }
    }

    throw new Error(\`[\${this.name}] Service not found or token not registered: \${token}\`);
  }

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
    const nameArg = this.graph.containerName ? `'${this.graph.containerName}'` : 'undefined';
    return `new NeoContainer(${buildArgs}, ${legacyArgs}, ${nameArg})`;
  }

  /**
   * Generates the container variable declaration with the user's export modifier.
   * This respects whether the user used 'export', 'export default', or no export at all.
   * If no modifier is specified (undefined), defaults to 'export' for backward compatibility.
   */
  private generateContainerVariable(): string {
    const variableName = this.graph.exportedVariableName || 'container';
    const instantiation = this.generateInstantiation();
    const exportModifier = this.graph.variableExportModifier;

    if (exportModifier === 'export default') {
      return `
// -- Container Instance --
const ${variableName} = ${instantiation};
export default ${variableName};
`;
    } else if (exportModifier === 'none') {
      // User explicitly did not export the variable
      return `
// -- Container Instance --
const ${variableName} = ${instantiation};
`;
    } else {
      // 'export' or undefined (backward compatibility)
      // Default to 'export' for backward compatibility when modifier is not set
      return `
// -- Container Instance --
export const ${variableName} = ${instantiation};
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
}
