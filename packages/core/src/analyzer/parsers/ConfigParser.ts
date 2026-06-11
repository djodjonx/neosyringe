import type * as ts from 'typescript';
import { basename } from 'node:path';
import { TSContext } from '../../TSContext';
import type { AnalysisError, DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';
import { HashUtils } from '../shared/HashUtils';
import { InjectionParser, type ParsedInjection } from './InjectionParser';

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
  private readonly injectionParser: InjectionParser;

  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService
  ) {
    this.injectionParser = new InjectionParser(checker, tokenResolverService);
  }

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
    if (!TSContext.ts.isObjectLiteralExpression(configObj)) return;

    // Parse 'name' property for containerName and containerId
    const nameProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'name'
    );

    if (nameProp && TSContext.ts.isPropertyAssignment(nameProp) && TSContext.ts.isStringLiteral(nameProp.initializer)) {
      graph.containerName = nameProp.initializer.text;
      graph.containerId = nameProp.initializer.text;
    } else {
      // Generate hash-based containerId if no name field
      graph.containerId = this.generateHashBasedContainerId(node);
    }

    // Parse 'injections' property
    const injectionsProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'injections'
    );

    if (injectionsProp && TSContext.ts.isPropertyAssignment(injectionsProp) && TSContext.ts.isArrayLiteralExpression(injectionsProp.initializer)) {
      this.parseInjectionsArray(injectionsProp.initializer, graph);
    }

    // Parse 'extends' property
    const extendsProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'extends'
    );

    if (extendsProp && TSContext.ts.isPropertyAssignment(extendsProp) && TSContext.ts.isArrayLiteralExpression(extendsProp.initializer)) {
      this.parseExtendsArray(extendsProp.initializer, graph, parentContainerNames);
    }

    // Parse 'useContainer' property
    const useContainerProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'useContainer'
    );

    if (useContainerProp && TSContext.ts.isPropertyAssignment(useContainerProp)) {
      if (!graph.legacyContainers) graph.legacyContainers = [];
      if (!graph.parentProvidedTokens) graph.parentProvidedTokens = new Set();

      const containerExpr = useContainerProp.initializer;

      if (TSContext.ts.isIdentifier(containerExpr)) {
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
      if (TSContext.ts.isObjectLiteralExpression(element)) {
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
    const sourceFile = obj.getSourceFile();
    const result = this.injectionParser.parse(obj, sourceFile);

    if (result === null) return;

    if (this.isAnalysisError(result)) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push(result);
      return;
    }

    const parsed = result;
    const { tokenId, tokenNode, tokenSymbol, isInterfaceToken, isValueToken,
            isMulti, isScoped, lifecycle, valueSource, factorySource, isAsync,
            implementationSymbol, registrationType } = parsed;
    const tokenText = parsed.tokenText;

    if (registrationType === 'value') {
      if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
      const definition: ServiceDefinition = {
        tokenId,
        registrationNode: obj,
        type: 'value',
        lifecycle: 'singleton',
        isInterfaceToken,
        valueSource: valueSource!,
        isScoped,
      };
      this.addToGraph(isMulti, tokenId, { service: definition, dependencies: [] }, graph);
      return;
    }

    if (registrationType === 'factory') {
      if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
      if (graph.nodes.has(tokenId) && !isScoped) {
        if (!graph.errors) graph.errors = [];
        graph.errors.push({
          type: 'duplicate',
          message: `Duplicate registration: '${tokenText}' is already registered.`,
          node: obj,
          sourceFile,
        });
        return;
      }
      const definition: ServiceDefinition = {
        tokenId,
        tokenSymbol: tokenSymbol ? this.resolveSymbol(tokenSymbol) : undefined,
        registrationNode: obj,
        type: 'factory',
        lifecycle,
        isInterfaceToken,
        isValueToken,
        factorySource: factorySource!,
        isScoped,
        isAsync: isAsync || undefined,
      };
      this.addToGraph(isMulti, tokenId, { service: definition, dependencies: [] }, graph);
      return;
    }

    // explicit / autowire
    if (!implementationSymbol) return;
    if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
    if (graph.nodes.has(tokenId) && !isScoped) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push({
        type: 'duplicate',
        message: `Duplicate registration: '${tokenText}' is already registered.`,
        node: obj,
        sourceFile,
      });
      return;
    }

    if (registrationType === 'explicit' && isInterfaceToken && parsed.providerNode) {
      this.validateTypeCompatibility(tokenNode, parsed.providerNode, obj, graph);
    }

    const resolvedImpl = this.resolveSymbol(implementationSymbol);
    const definition: ServiceDefinition = {
      tokenId,
      implementationSymbol: resolvedImpl,
      tokenSymbol: tokenSymbol ? this.resolveSymbol(tokenSymbol) : undefined,
      registrationNode: obj,
      type: registrationType,
      lifecycle,
      isInterfaceToken,
      isScoped,
      isDisposable: parsed.isDisposable || undefined,
      isAsyncDisposable: parsed.isAsyncDisposable || undefined,
      implementationLocalName: parsed.implementationLocalName,
      tokenLocalName: parsed.tokenLocalName,
    };
    this.addToGraph(isMulti, tokenId, { service: definition, dependencies: [] }, graph);
  }

  private addToGraph(
    isMulti: boolean,
    tokenId: TokenId,
    node: DependencyNode,
    graph: DependencyGraph
  ): void {
    if (isMulti) {
      if (!graph.multiNodes) graph.multiNodes = new Map();
      const existing = graph.multiNodes.get(tokenId) ?? [];
      existing.push(node);
      graph.multiNodes.set(tokenId, existing);
    } else {
      graph.nodes.set(tokenId, node);
    }
  }

  private isAnalysisError(result: ParsedInjection | AnalysisError): result is AnalysisError {
    return !('__kind' in result);
  }

  /**
   * Emits an error if a token is registered both with and without `multi: true`.
   *
   * @returns true if an error was emitted (caller should return early), false otherwise.
   */
  private emitMixedMultiError(
    isMulti: boolean,
    tokenId: TokenId,
    tokenText: string,
    obj: ts.ObjectLiteralExpression,
    graph: DependencyGraph
  ): boolean {
    const sourceFile = obj.getSourceFile();
    const msg = `Token '${tokenText}' is registered both with and without 'multi: true'. All registrations for a token must consistently use multi: true or not at all.`;
    if (isMulti && graph.nodes.has(tokenId)) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push({ type: 'duplicate', message: msg, node: obj, sourceFile });
      return true;
    }
    if (!isMulti && graph.multiNodes?.has(tokenId)) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push({ type: 'duplicate', message: msg, node: obj, sourceFile });
      return true;
    }
    return false;
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
    if (TSContext.ts.isExpression(tokenNode)) {
      const resolved = this.tokenResolverService.resolveToInitializer(tokenNode);
      if (resolved) {
        resolvedTokenNode = resolved;
      }
    }

    if (TSContext.ts.isExpression(resolvedTokenNode) && this.tokenResolverService.isUseInterfaceCall(resolvedTokenNode)) {
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
      if (TSContext.ts.isIdentifier(element)) {
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
    if (TSContext.ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        TSContext.ts.isCallExpression(declaration.initializer)) {
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
    if (TSContext.ts.isIdentifier(expression)) {
      return expression.text === 'definePartialConfig';
    }
    return false;
  }

  /**
   * Generates a hash-based container ID when no name is provided.
   */
  private generateHashBasedContainerId(node: ts.CallExpression): string {
    const sourceFile = node.getSourceFile();
    const fileName = basename(sourceFile.fileName, '.ts');
    const position = node.getStart();
    const configText = node.getText();

    return HashUtils.generateContainerId(fileName, position, configText);
  }

  /**
   * Resolves a symbol, following aliases. Delegates to the shared TokenResolverService.
   */
  private resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    return this.tokenResolverService.resolveSymbol(symbol);
  }
}
