import * as ts from 'typescript';
import type { DependencyGraph, ServiceDefinition, TokenId } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';
import { HashUtils } from '../shared/HashUtils';

/**
 * Service responsible for parsing defineBuilderConfig and definePartialConfig calls.
 *
 * This parser extracts configuration information from AST nodes and populates
 * the dependency graph. It handles:
 * - Container name and ID extraction
 * - Injection array parsing
 * - Extends array parsing (partial configs)
 * - Parent container references (useContainer)
 *
 * @example
 * ```typescript
 * const parser = new ConfigParser(checker, tokenResolverService);
 * const graph: DependencyGraph = { nodes: new Map(), roots: [], errors: [] };
 *
 * parser.parseBuilderConfig(configCallNode, graph);
 * // graph is now populated with services
 * ```
 */
export class ConfigParser {
  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService
  ) {}

  /**
   * Parses a defineBuilderConfig or definePartialConfig call expression.
   *
   * Extracts all configuration properties and populates the dependency graph.
   *
   * @param node - The defineBuilderConfig/definePartialConfig call expression
   * @param graph - The dependency graph to populate
   * @param parentContainerNames - Set of parent container names for reference
   *
   * @example
   * ```typescript
   * const callExpr = ...; // defineBuilderConfig({ name: 'App', injections: [...] })
   * parser.parseBuilderConfig(callExpr, graph, parentContainerNames);
   * ```
   */
  parseBuilderConfig(
    node: ts.CallExpression,
    graph: DependencyGraph,
    parentContainerNames: Set<string>
  ): void {
    const args = node.arguments;
    if (args.length < 1) return;

    const configObj = args[0];
    if (!ts.isObjectLiteralExpression(configObj)) return;

    // Parse 'name' property for containerName and containerId
    const nameProp = configObj.properties.find(p =>
      p.name && ts.isIdentifier(p.name) && p.name.text === 'name'
    );

    if (nameProp && ts.isPropertyAssignment(nameProp) && ts.isStringLiteral(nameProp.initializer)) {
      graph.containerName = nameProp.initializer.text;
      graph.containerId = nameProp.initializer.text;
    } else {
      // Generate hash-based containerId if no name field
      graph.containerId = this.generateHashBasedContainerId(node);
    }

    // Parse 'injections' property
    const injectionsProp = configObj.properties.find(p =>
      p.name && ts.isIdentifier(p.name) && p.name.text === 'injections'
    );

    if (injectionsProp && ts.isPropertyAssignment(injectionsProp) && ts.isArrayLiteralExpression(injectionsProp.initializer)) {
      this.parseInjectionsArray(injectionsProp.initializer, graph);
    }

    // Parse 'extends' property
    const extendsProp = configObj.properties.find(p =>
      p.name && ts.isIdentifier(p.name) && p.name.text === 'extends'
    );

    if (extendsProp && ts.isPropertyAssignment(extendsProp) && ts.isArrayLiteralExpression(extendsProp.initializer)) {
      this.parseExtendsArray(extendsProp.initializer, graph, parentContainerNames);
    }

    // Parse 'useContainer' property
    const useContainerProp = configObj.properties.find(p =>
      p.name && ts.isIdentifier(p.name) && p.name.text === 'useContainer'
    );

    if (useContainerProp && ts.isPropertyAssignment(useContainerProp)) {
      if (!graph.legacyContainers) graph.legacyContainers = [];
      if (!graph.parentProvidedTokens) graph.parentProvidedTokens = new Set();

      const containerExpr = useContainerProp.initializer;

      if (ts.isIdentifier(containerExpr)) {
        graph.legacyContainers.push(containerExpr.text);
        // Mark as parent container
        parentContainerNames.add(containerExpr.text);
      }
    }
  }

  /**
   * Parses an array of injection objects.
   *
   * @param arrayLiteral - The injections array literal
   * @param graph - The dependency graph to populate
   */
  private parseInjectionsArray(arrayLiteral: ts.ArrayLiteralExpression, graph: DependencyGraph): void {
    for (const element of arrayLiteral.elements) {
      if (ts.isObjectLiteralExpression(element)) {
        this.parseInjectionObject(element, graph);
      }
    }
  }

  /**
   * Parses a single injection object.
   *
   * Extracts token, provider, lifecycle, factory configuration, etc.
   * and creates a ServiceDefinition in the graph.
   *
   * @param obj - The injection object literal
   * @param graph - The dependency graph to populate
   */
  parseInjectionObject(obj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    // Extract properties: token, provider, lifecycle, useFactory, scoped
    let tokenNode: ts.Expression | undefined;
    let providerNode: ts.Expression | undefined;
    let lifecycle: 'singleton' | 'transient' = 'singleton';
    let useFactory = false;
    let isScoped = false;

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      if (prop.name.text === 'token') {
        tokenNode = prop.initializer;
      } else if (prop.name.text === 'provider') {
        providerNode = prop.initializer;
      } else if (prop.name.text === 'lifecycle' && ts.isStringLiteral(prop.initializer)) {
        if (prop.initializer.text === 'transient') lifecycle = 'transient';
      } else if (prop.name.text === 'useFactory') {
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          useFactory = true;
        }
      } else if (prop.name.text === 'scoped') {
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
          isScoped = true;
        }
      }
    }

    if (!tokenNode) return;

    // Auto-detect factory if provider is an arrow function or function expression
    if (providerNode && (ts.isArrowFunction(providerNode) || ts.isFunctionExpression(providerNode))) {
      useFactory = true;
    }

    let tokenId: TokenId;
    let implementationSymbol: ts.Symbol | undefined;
    let tokenSymbol: ts.Symbol | undefined;
    let type: 'explicit' | 'autowire' | 'factory' = 'autowire';
    let isInterfaceToken = false;
    let isValueToken = false;
    let factorySource: string | undefined;

    // Resolve variable references to their initializers
    let resolvedTokenNode = tokenNode;
    const resolved = this.tokenResolverService.resolveToInitializer(tokenNode);
    if (resolved) {
      resolvedTokenNode = resolved;
    }

    // 1. Resolve Token ID
    if (this.tokenResolverService.isUseInterfaceCall(resolvedTokenNode)) {
      // Case: token: useInterface<I>()
      tokenId = this.tokenResolverService.extractInterfaceTokenId(resolvedTokenNode);
      type = 'explicit';
      isInterfaceToken = true;
    } else if (this.tokenResolverService.isUsePropertyCall(resolvedTokenNode)) {
      // Case: token: useProperty<T>(Class, 'paramName')
      const propertyTokenId = this.tokenResolverService.extractPropertyTokenId(resolvedTokenNode);
      tokenId = propertyTokenId;
      type = 'explicit';
      isValueToken = true;

      // Property tokens MUST have a factory provider
      if (!providerNode) {
        throw new Error(`useProperty requires a provider (factory).`);
      }
      useFactory = true;
    } else {
      // Case: token: Class
      const tokenType = this.checker.getTypeAtLocation(tokenNode);
      tokenId = this.tokenResolverService.getTypeIdFromConstructor(tokenType);
      if (ts.isIdentifier(tokenNode)) {
        tokenSymbol = this.checker.getSymbolAtLocation(tokenNode);
      }
    }

    // 2. Handle Factory
    if (useFactory && providerNode) {
      factorySource = providerNode.getText();
      type = 'factory';

      if (tokenId) {
        // Check for duplicate - allow if scoped: true (intentional override)
        if (graph.nodes.has(tokenId) && !isScoped) {
          const sourceFile = obj.getSourceFile();
          const tokenText = tokenNode.getText(sourceFile);

          if (!graph.errors) graph.errors = [];
          graph.errors.push({
            type: 'duplicate',
            message: `Duplicate registration: '${tokenText}' is already registered.`,
            node: obj,
            sourceFile: sourceFile
          });
          return;
        }

        const definition: ServiceDefinition = {
          tokenId,
          tokenSymbol: tokenSymbol ? this.resolveSymbol(tokenSymbol) : undefined,
          registrationNode: obj,
          type: 'factory',
          lifecycle: lifecycle,
          isInterfaceToken,
          isValueToken,
          isFactory: true,
          factorySource,
          isScoped
        };
        graph.nodes.set(tokenId, { service: definition, dependencies: [] });
      }
      return;
    }

    // 3. Resolve Implementation (non-factory)
    if (providerNode) {
      implementationSymbol = this.checker.getSymbolAtLocation(providerNode);
      type = 'explicit';
    } else {
      // Autowiring: Provider is the Token Class itself
      if (ts.isIdentifier(tokenNode)) {
        implementationSymbol = this.checker.getSymbolAtLocation(tokenNode);
        type = 'autowire';
      }
    }

    if (tokenId && implementationSymbol) {
      // Check for duplicate - allow if scoped: true
      if (graph.nodes.has(tokenId) && !isScoped) {
        const sourceFile = obj.getSourceFile();
        const tokenText = tokenNode.getText(sourceFile);

        if (!graph.errors) graph.errors = [];
        graph.errors.push({
          type: 'duplicate',
          message: `Duplicate registration: '${tokenText}' is already registered.`,
          node: obj,
          sourceFile: sourceFile
        });
        return;
      }

      // Type validation for explicit interface registrations
      if (type === 'explicit' && isInterfaceToken && providerNode) {
        this.validateTypeCompatibility(tokenNode, providerNode, obj, graph);
      }

      const definition: ServiceDefinition = {
        tokenId,
        implementationSymbol: this.resolveSymbol(implementationSymbol),
        tokenSymbol: tokenSymbol ? this.resolveSymbol(tokenSymbol) : undefined,
        registrationNode: obj,
        type: type,
        lifecycle: lifecycle,
        isInterfaceToken: isInterfaceToken || this.tokenResolverService.isUseInterfaceCall(tokenNode),
        isScoped
      };
      graph.nodes.set(tokenId, { service: definition, dependencies: [] });
    }
  }

  /**
   * Validates type compatibility between token and provider.
   *
   * @param tokenNode - The token expression
   * @param providerNode - The provider expression
   * @param registrationNode - The registration object for error reporting
   * @param graph - The dependency graph to collect errors
   */
  private validateTypeCompatibility(
    tokenNode: ts.Node,
    providerNode: ts.Node,
    registrationNode: ts.Node,
    graph: DependencyGraph
  ): void {
    let tokenType: ts.Type | undefined;

    // Resolve tokenNode to the actual call expression
    let resolvedTokenNode = tokenNode;
    if (ts.isExpression(tokenNode)) {
      const resolved = this.tokenResolverService.resolveToInitializer(tokenNode);
      if (resolved) {
        resolvedTokenNode = resolved;
      }
    }

    if (ts.isExpression(resolvedTokenNode) && this.tokenResolverService.isUseInterfaceCall(resolvedTokenNode)) {
      const typeArgs = resolvedTokenNode.typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        tokenType = this.checker.getTypeFromTypeNode(typeArgs[0]);
      }
    }

    if (!tokenType) return;

    // Get provider type
    const providerType = this.checker.getTypeAtLocation(providerNode);

    // Get instance type
    let providerInstanceType: ts.Type | undefined;
    const constructSignatures = providerType.getConstructSignatures();
    if (constructSignatures.length > 0) {
      providerInstanceType = constructSignatures[0].getReturnType();
    } else {
      providerInstanceType = providerType;
    }

    if (!providerInstanceType) return;

    // Check assignability
    const isAssignable = this.checker.isTypeAssignableTo(providerInstanceType, tokenType);

    if (!isAssignable) {
      const sourceFile = registrationNode.getSourceFile();
      const tokenTypeName = this.checker.typeToString(tokenType);
      const providerTypeName = this.checker.typeToString(providerInstanceType);

      if (!graph.errors) graph.errors = [];
      graph.errors.push({
        type: 'type-mismatch',
        message: `Type mismatch: Provider '${providerTypeName}' is not assignable to token type '${tokenTypeName}'.`,
        node: registrationNode,
        sourceFile: sourceFile
      });
    }
  }

  /**
   * Parses the extends array to incorporate partial configurations.
   *
   * @param arrayLiteral - The extends array literal
   * @param graph - The dependency graph to populate
   * @param parentContainerNames - Set of parent container names
   */
  private parseExtendsArray(
    arrayLiteral: ts.ArrayLiteralExpression,
    graph: DependencyGraph,
    parentContainerNames: Set<string>
  ): void {
    for (const element of arrayLiteral.elements) {
      if (ts.isIdentifier(element)) {
        this.parsePartialConfig(element, graph, parentContainerNames);
      }
    }
  }

  /**
   * Parses a partial config referenced by identifier.
   *
   * @param identifier - The partial config identifier
   * @param graph - The dependency graph to populate
   * @param parentContainerNames - Set of parent container names
   */
  private parsePartialConfig(
    identifier: ts.Identifier,
    graph: DependencyGraph,
    parentContainerNames: Set<string>
  ): void {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (!symbol) return;

    const resolvedSymbol = this.resolveSymbol(symbol);
    const declaration = resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0];

    if (!declaration) return;

    // Expect: const config = definePartialConfig({...})
    if (ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer)) {
      const callExpr = declaration.initializer;

      if (this.isDefinePartialConfigCall(callExpr)) {
        // Recursive reuse!
        this.parseBuilderConfig(callExpr, graph, parentContainerNames);
      }
    }
  }

  /**
   * Checks if a call expression is definePartialConfig.
   */
  private isDefinePartialConfigCall(node: ts.CallExpression): boolean {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      return expression.text === 'definePartialConfig';
    }
    return false;
  }

  /**
   * Generates a hash-based container ID when no name is provided.
   */
  private generateHashBasedContainerId(node: ts.CallExpression): string {
    const sourceFile = node.getSourceFile();
    const path = require('path');
    const fileName = path.basename(sourceFile.fileName, '.ts');
    const position = node.getStart();
    const configText = node.getText();

    return HashUtils.generateContainerId(fileName, position, configText);
  }

  /**
   * Resolves a symbol, following aliases.
   */
  private resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    if (symbol.flags & ts.SymbolFlags.Alias) {
      return this.resolveSymbol(this.checker.getAliasedSymbol(symbol));
    }
    return symbol;
  }
}
