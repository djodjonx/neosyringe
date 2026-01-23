import * as ts from 'typescript';
import type { ConfigGraph, ServiceDefinition, InjectionInfo, ConfigType, TokenId } from '../types';
import { HashUtils, TokenResolverService } from '../shared';

/**
 * Interface for collecting configurations from source files.
 */
export interface IConfigCollector {
  /** Collect all configs from the program */
  collect(): Map<string, ConfigGraph>;
}

/**
 * Collects defineBuilderConfig and definePartialConfig calls from the program.
 *
 * This collector scans all source files for container configurations and builds
 * a map of ConfigGraph objects. It uses the TokenResolverService for consistent
 * token ID generation across the analyzer.
 *
 * @example
 * ```typescript
 * const collector = new ConfigCollector(program, checker);
 * const configs = collector.collect();
 *
 * for (const [key, config] of configs) {
 *   console.log(`Found config: ${config.containerId}`);
 *   console.log(`Injections: ${config.localInjections.size}`);
 * }
 * ```
 */
export class ConfigCollector implements IConfigCollector {
  private tokenResolverService: TokenResolverService;

  constructor(
    private program: ts.Program,
    private checker: ts.TypeChecker
  ) {
    this.tokenResolverService = new TokenResolverService(checker);
  }

  collect(): Map<string, ConfigGraph> {
    const configs = new Map<string, ConfigGraph>();
    const containerIdsByFile = new Map<string, Map<string, ConfigGraph>>();

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;

      const fileConfigs = new Map<string, ConfigGraph>();
      this.visitNode(sourceFile, sourceFile, configs, fileConfigs);

      if (fileConfigs.size > 0) {
        containerIdsByFile.set(sourceFile.fileName, fileConfigs);
      }
    }

    // Validate no duplicate containerIds in the same file
    this.validateContainerIdCollisions(containerIdsByFile);

    return configs;
  }

  private validateContainerIdCollisions(
    containerIdsByFile: Map<string, Map<string, ConfigGraph>>
  ): void {
    for (const [fileName, fileConfigs] of containerIdsByFile) {
      const seenIds = new Map<string, ConfigGraph>();

      for (const config of fileConfigs.values()) {
        const existing = seenIds.get(config.containerId);
        if (existing) {
          throw new Error(
            `Duplicate container name '${config.containerId}' found in ${fileName}.\n` +
            `Each container must have a unique 'name' field within the same file.\n` +
            `First occurrence: line ${config.sourceFile.getLineAndCharacterOfPosition(existing.node.getStart()).line + 1}\n` +
            `Second occurrence: line ${config.sourceFile.getLineAndCharacterOfPosition(config.node.getStart()).line + 1}`
          );
        }
        seenIds.set(config.containerId, config);
      }
    }
  }

  /**
   * Recursively visits AST nodes to find container configurations.
   *
   * Identifies defineBuilderConfig and definePartialConfig calls and
   * collects them into the configs map with unique keys.
   *
   * @param node - AST node to visit
   * @param sourceFile - Source file containing the node
   * @param configs - Global map of all configs
   * @param fileConfigs - Optional map of configs in this file only (for validation)
   */
  private visitNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    configs: Map<string, ConfigGraph>,
    fileConfigs?: Map<string, ConfigGraph>
  ): void {
    if (ts.isCallExpression(node)) {
      const config = this.tryParseConfig(node, sourceFile);
      if (config) {
        // Use unique key: fileName:variableName to avoid collisions
        const uniqueKey = `${sourceFile.fileName}:${config.name}`;
        configs.set(uniqueKey, config);
        if (fileConfigs) {
          // Use unique key for fileConfigs too (name + position)
          const fileUniqueKey = `${config.name}:${node.getStart()}`;
          fileConfigs.set(fileUniqueKey, config);
        }
      }
    }

    ts.forEachChild(node, (child) => this.visitNode(child, sourceFile, configs, fileConfigs));
  }

  /**
   * Attempts to parse a call expression as a container configuration.
   *
   * Checks if the call is to defineBuilderConfig or definePartialConfig
   * and delegates to parseConfig if so.
   *
   * @param node - Call expression to analyze
   * @param sourceFile - Source file containing the call
   * @returns ConfigGraph if successful, null otherwise
   */
  private tryParseConfig(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile
  ): ConfigGraph | null {
    const funcName = this.getFunctionName(node);

    if (funcName === 'defineBuilderConfig') {
      return this.parseConfig(node, sourceFile, 'builder');
    }

    if (funcName === 'definePartialConfig') {
      return this.parseConfig(node, sourceFile, 'partial');
    }

    return null;
  }

  private getFunctionName(node: ts.CallExpression): string | null {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      return expression.text;
    }
    return null;
  }

  private parseConfig(
    node: ts.CallExpression,
    sourceFile: ts.SourceFile,
    type: ConfigType
  ): ConfigGraph | null {
    // Get the variable name
    const name = this.getConfigName(node);
    if (!name) return null;

    // Parse the config object
    const configArg = node.arguments[0];
    if (!configArg || !ts.isObjectLiteralExpression(configArg)) {
      return null;
    }

    // Generate unique container ID from 'name' field or hash
    const containerId = this.generateContainerId(configArg, sourceFile, node.getStart());

    // Collect injections and detect internal duplicates
    const { injections: localInjections, duplicates } = this.collectInjections(configArg, sourceFile);

    // Get extends and useContainer (for builders only)
    const extendsRefs = type === 'builder' ? this.getExtendsRefs(configArg) : [];
    const useContainerRef = type === 'builder' ? this.getUseContainerRef(configArg) : null;

    // Get legacy parent tokens (for builders with declareContainerTokens parent)
    const legacyParentTokens = type === 'builder' && useContainerRef
      ? this.extractLegacyParentTokens(useContainerRef, sourceFile)
      : undefined;

    // Get container name
    const containerName = this.getContainerName(configArg);

    return {
      containerId,
      name,
      type,
      sourceFile,
      node,
      localInjections,
      duplicates,
      extendsRefs,
      useContainerRef,
      legacyParentTokens,
      containerName,
    };
  }

  private getConfigName(node: ts.CallExpression): string | null {
    const parent = node.parent;

    // Case 1: const x = defineBuilderConfig(...)
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }

    // Case 2: export default defineBuilderConfig(...)
    if (ts.isExportAssignment(parent)) {
      return '__default__';
    }

    return null;
  }

  private collectInjections(
    configObj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): { injections: Map<TokenId, InjectionInfo>; duplicates: InjectionInfo[] } {
    const injections = new Map<TokenId, InjectionInfo>();
    const duplicates: InjectionInfo[] = [];

    // Find the 'injections' property
    const injectionsProperty = this.findProperty(configObj, 'injections');
    if (!injectionsProperty || !ts.isArrayLiteralExpression(injectionsProperty.initializer)) {
      return { injections, duplicates };
    }

    // Parse each injection
    for (const element of injectionsProperty.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;

      const info = this.parseInjection(element, sourceFile);
      if (info) {
        if (injections.has(info.definition.tokenId)) {
          // This is a duplicate - store it for error reporting
          duplicates.push(info);
        } else {
          injections.set(info.definition.tokenId, info);
        }
      }
    }

    return { injections, duplicates };
  }

  private parseInjection(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): InjectionInfo | null {
    let tokenNode: ts.Expression | undefined;
    let providerNode: ts.Expression | undefined;
    let lifecycle: 'singleton' | 'transient' = 'singleton';
    let useFactory = false;
    let isScoped = false;

    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;

      switch (prop.name.text) {
        case 'token':
          tokenNode = prop.initializer;
          break;
        case 'provider':
          providerNode = prop.initializer;
          break;
        case 'lifecycle':
          if (ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'transient') {
            lifecycle = 'transient';
          }
          break;
        case 'useFactory':
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            useFactory = true;
          }
          break;
        case 'scoped':
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            isScoped = true;
          }
          break;
      }
    }

    if (!tokenNode) return null;

    // Get token text for error messages
    const tokenText = tokenNode.getText(sourceFile);

    // Resolve token ID
    const tokenId = this.resolveTokenId(tokenNode);
    if (!tokenId) return null;

    // Auto-detect factory
    if (providerNode && (ts.isArrowFunction(providerNode) || ts.isFunctionExpression(providerNode))) {
      useFactory = true;
    }

    // Determine registration type
    let registrationType: 'explicit' | 'autowire' | 'factory' = 'autowire';
    if (useFactory) {
      registrationType = 'factory';
    } else if (providerNode) {
      registrationType = 'explicit';
    }

    // Get implementation symbol
    const implementationSymbol = providerNode
      ? this.getSymbolForNode(providerNode)
      : this.getSymbolForNode(tokenNode);

    // Determine if interface token
    const isInterfaceToken = this.isUseInterfaceCall(tokenNode);

    const definition: ServiceDefinition = {
      tokenId,
      implementationSymbol,
      registrationNode: obj,
      type: registrationType,
      lifecycle,
      isInterfaceToken,
      isFactory: useFactory,
      factorySource: useFactory && providerNode ? providerNode.getText(sourceFile) : undefined,
      isScoped,
    };

    return {
      definition,
      node: obj,
      tokenText,
      isScoped,
    };
  }

  /**
   * Resolves a token ID from an expression node.
   *
   * Uses the TokenResolverService for consistent token ID generation.
   * This ensures tokens are resolved the same way across the analyzer.
   *
   * @param tokenNode - Expression node to resolve
   * @returns Token ID or null if not resolvable
   */
  private resolveTokenId(tokenNode: ts.Expression): TokenId | null {
    return this.tokenResolverService.resolveTokenId(tokenNode);
  }

  /**
   * Checks if a node is a useInterface call expression.
   */
  private isUseInterfaceCall(node: ts.Expression): boolean {
    return this.tokenResolverService.isUseInterfaceCall(node);
  }

  private simpleHash(str: string): string {
    // Deprecated - use generateTokenId instead
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).slice(0, 8);
  }

  private getSymbolForNode(node: ts.Node): ts.Symbol | undefined {
    return this.checker.getSymbolAtLocation(node);
  }

  private getExtendsRefs(configObj: ts.ObjectLiteralExpression): string[] {
    const refs: string[] = [];
    const extendsProp = this.findProperty(configObj, 'extends');

    if (extendsProp && ts.isArrayLiteralExpression(extendsProp.initializer)) {
      for (const element of extendsProp.initializer.elements) {
        if (ts.isIdentifier(element)) {
          refs.push(element.text);
        }
      }
    }

    return refs;
  }

  private getUseContainerRef(configObj: ts.ObjectLiteralExpression): string | null {
    const useContainerProp = this.findProperty(configObj, 'useContainer');

    if (useContainerProp && ts.isIdentifier(useContainerProp.initializer)) {
      return useContainerProp.initializer.text;
    }

    return null;
  }

  private getContainerName(configObj: ts.ObjectLiteralExpression): string | undefined {
    const nameProp = this.findProperty(configObj, 'name');

    if (nameProp && ts.isStringLiteral(nameProp.initializer)) {
      return nameProp.initializer.text;
    }

    return undefined;
  }

  /**
   * Extracts tokens from a legacy parent container (declareContainerTokens).
   * @param useContainerRef - Variable name of the parent container
   * @param sourceFile - Source file containing the reference
   * @returns Set of token IDs provided by the legacy container, or undefined if not a legacy container
   */
  private extractLegacyParentTokens(
    useContainerRef: string,
    sourceFile: ts.SourceFile
  ): Set<string> | undefined {
    // Find the declaration of the parent container
    const identifier = this.findIdentifierInFile(useContainerRef, sourceFile);
    if (!identifier) return undefined;

    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (!symbol) return undefined;

    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) return undefined;

    // Check if it's a declareContainerTokens call
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isCallExpression(declaration.initializer)
    ) {
      const callExpr = declaration.initializer;

      // Check if it's declareContainerTokens
      if (
        ts.isIdentifier(callExpr.expression) &&
        callExpr.expression.text === 'declareContainerTokens'
      ) {
        return this.extractDeclaredTokens(callExpr);
      }
    }

    return undefined;
  }

  /**
   * Extracts tokens from declareContainerTokens<{ Token: Type }>().
   *
   * @param node - The declareContainerTokens call expression
   * @returns Set of token IDs or undefined if empty
   */
  private extractDeclaredTokens(node: ts.CallExpression): Set<string> | undefined {
    if (!node.typeArguments || node.typeArguments.length === 0) {
      return undefined;
    }

    const typeArg = node.typeArguments[0];
    const type = this.checker.getTypeFromTypeNode(typeArg);

    const tokens = new Set<string>();
    const properties = type.getProperties();

    for (const prop of properties) {
      const propType = this.checker.getTypeOfSymbol(prop);
      if (propType) {
        const tokenId = this.tokenResolverService.getTypeId(propType);
        tokens.add(tokenId);
      }
    }

    return tokens.size > 0 ? tokens : undefined;
  }

  /**
   * Helper to find an identifier in a source file.
   */
  private findIdentifierInFile(
    name: string,
    sourceFile: ts.SourceFile
  ): ts.Identifier | undefined {
    let result: ts.Identifier | undefined;

    const visit = (node: ts.Node) => {
      if (result) return;

      if (ts.isIdentifier(node) && node.text === name) {
        result = node;
        return;
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return result;
  }

  private findProperty(
    obj: ts.ObjectLiteralExpression,
    name: string
  ): ts.PropertyAssignment | undefined {
    for (const prop of obj.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === name
      ) {
        return prop;
      }
    }
    return undefined;
  }

  /**
   * Generates a unique container ID from the 'name' field or a hash.
   * Priority 1: Use the 'name' field from the config object
   * Priority 2: Generate a stable hash based on file + position + content
   *
   * @param configObject - The configuration object literal
   * @param sourceFile - Source file containing the config
   * @param position - Position of the config in the file
   * @returns Unique container ID
   */
  private generateContainerId(
    configObject: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    position: number
  ): string {
    // Priority 1: Extract the 'name' field
    const configName = this.extractConfigName(configObject);
    if (configName) {
      return configName;
    }

    // Priority 2: Generate a hash using HashUtils
    const path = require('path');
    const fileName = path.basename(sourceFile.fileName, '.ts');
    const configText = configObject.getText();

    return HashUtils.generateContainerId(fileName, position, configText);
  }

  /**
   * Extracts the value of the 'name' field from a config object.
   *
   * @param configObject - The configuration object literal
   * @returns The name string or undefined if not present
   */
  private extractConfigName(configObject: ts.ObjectLiteralExpression): string | undefined {
    for (const prop of configObject.properties) {
      if (ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'name') {

        // The value should be a string literal
        if (ts.isStringLiteral(prop.initializer)) {
          return prop.initializer.text;
        }
      }
    }

    return undefined;
  }
}
