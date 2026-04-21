import type * as ts from 'typescript';
import { basename } from 'path';
import { TSContext } from '../../TSContext';
import type { ConfigGraph, ServiceDefinition, InjectionInfo, ConfigType, TokenId, AnalysisError } from '../types';
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
    if (TSContext.ts.isCallExpression(node)) {
      const config = this.tryParseConfig(node, sourceFile);
      if (config) {
        // Global key uses fileName:name to guarantee uniqueness across all files.
        // Per-file key uses name:position to allow the same name in different
        // files without collision during the intra-file duplicate-id check.
        const uniqueKey = `${sourceFile.fileName}:${config.name}`;
        configs.set(uniqueKey, config);
        if (fileConfigs) {
          const fileUniqueKey = `${config.name}:${node.getStart()}`;
          fileConfigs.set(fileUniqueKey, config);
        }
      }
    }

    TSContext.ts.forEachChild(node, (child) => this.visitNode(child, sourceFile, configs, fileConfigs));
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
    if (TSContext.ts.isIdentifier(expression)) {
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
    if (!configArg || !TSContext.ts.isObjectLiteralExpression(configArg)) {
      return null;
    }

    // Generate unique container ID from 'name' field or hash
    const containerId = this.generateContainerId(configArg, sourceFile, node.getStart());

    // Collect injections and detect internal duplicates
    const { injections: localInjections, duplicates, valueErrors, multiInjections } = this.collectInjections(configArg, sourceFile);

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
      valueErrors: valueErrors.length > 0 ? valueErrors : undefined,
      multiInjections: multiInjections && multiInjections.size > 0 ? multiInjections : undefined,
    };
  }

  private getConfigName(node: ts.CallExpression): string | null {
    const parent = node.parent;

    // Case 1: const x = defineBuilderConfig(...)
    if (TSContext.ts.isVariableDeclaration(parent) && TSContext.ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }

    // Case 2: export default defineBuilderConfig(...)
    if (TSContext.ts.isExportAssignment(parent)) {
      return '__default__';
    }

    return null;
  }

  private collectInjections(
    configObj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): { injections: Map<TokenId, InjectionInfo>; duplicates: InjectionInfo[]; valueErrors: AnalysisError[]; multiInjections?: Map<TokenId, InjectionInfo[]> } {
    const injections = new Map<TokenId, InjectionInfo>();
    const duplicates: InjectionInfo[] = [];
    const valueErrors: AnalysisError[] = [];
    let multiInjections: Map<TokenId, InjectionInfo[]> | undefined;

    // Find the 'injections' property
    const injectionsProperty = this.findProperty(configObj, 'injections');
    if (!injectionsProperty || !TSContext.ts.isArrayLiteralExpression(injectionsProperty.initializer)) {
      return { injections, duplicates, valueErrors };
    }

    // Parse each injection
    for (const element of injectionsProperty.initializer.elements) {
      if (!TSContext.ts.isObjectLiteralExpression(element)) continue;

      const info = this.parseInjection(element, sourceFile);
      if (info) {
        // Check if it's an AnalysisError (has type/message/node/sourceFile but not definition)
        if (!('definition' in info)) {
          valueErrors.push(info as unknown as AnalysisError);
          continue;
        }

        // Check for mixed multi/non-multi
        if (info.isMulti && injections.has(info.definition.tokenId)) {
          valueErrors.push({
            type: 'duplicate',
            message: `Token '${info.tokenText}' is registered both with and without 'multi: true'. All registrations for a token must consistently use multi: true or not at all.`,
            node: info.node,
            sourceFile,
          });
          continue;
        }
        if (!info.isMulti && multiInjections?.has(info.definition.tokenId)) {
          valueErrors.push({
            type: 'duplicate',
            message: `Token '${info.tokenText}' is registered both with and without 'multi: true'. All registrations for a token must consistently use multi: true or not at all.`,
            node: info.node,
            sourceFile,
          });
          continue;
        }

        if (info.isMulti) {
          if (!multiInjections) multiInjections = new Map();
          const existing = multiInjections.get(info.definition.tokenId) ?? [];
          existing.push(info);
          multiInjections.set(info.definition.tokenId, existing);
        } else if (injections.has(info.definition.tokenId)) {
          // This is a duplicate - store it for error reporting
          duplicates.push(info);
        } else {
          injections.set(info.definition.tokenId, info);
        }
      }
    }

    return { injections, duplicates, valueErrors, multiInjections };
  }

  private parseInjection(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): InjectionInfo | AnalysisError | null {
    let tokenNode: ts.Expression | undefined;
    let providerNode: ts.Expression | undefined;
    let lifecycle: 'singleton' | 'transient' = 'singleton';
    let useFactory = false;
    let isScoped = false;
    let valueNode: ts.Expression | undefined;
    let isMulti = false;

    for (const prop of obj.properties) {
      if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;

      switch (prop.name.text) {
        case 'token':
          tokenNode = prop.initializer;
          break;
        case 'provider':
          providerNode = prop.initializer;
          break;
        case 'lifecycle':
          if (TSContext.ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'transient') {
            lifecycle = 'transient';
          }
          break;
        case 'useFactory':
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) {
            useFactory = true;
          }
          break;
        case 'scoped':
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) {
            isScoped = true;
          }
          break;
        case 'useValue':
          valueNode = prop.initializer;
          break;
        case 'multi':
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) {
            isMulti = true;
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

    // Determine if interface token
    const isInterfaceToken = this.isUseInterfaceCall(tokenNode);

    // --- useValue path ---
    if (valueNode) {
      if (this.isUseInterfaceCall(tokenNode)) {
        const primitiveError = this.checkPrimitiveTokenForValue(tokenNode, obj, sourceFile);
        if (primitiveError) return primitiveError as any;
      }
      const definition: ServiceDefinition = {
        tokenId,
        registrationNode: obj,
        type: 'value',
        lifecycle: 'singleton',
        isInterfaceToken,
        valueSource: valueNode.getText(sourceFile),
        isScoped,
      };
      return { definition, node: obj, tokenText, isScoped, isMulti };
    }

    // Auto-detect factory
    if (providerNode && (TSContext.ts.isArrowFunction(providerNode) || TSContext.ts.isFunctionExpression(providerNode))) {
      useFactory = true;
    }

    // Detect async factory and validate constraint
    const isAsync = useFactory && providerNode ? this.isAsyncFunction(providerNode) : false;
    if (isAsync && lifecycle === 'transient') {
      return {
        type: 'type-mismatch' as const,
        message: `Async factory for '${tokenText}' cannot use lifecycle: 'transient'. Async factories are pre-initialized once in initialize() and must be singletons. Remove lifecycle: 'transient' or make the factory synchronous.`,
        node: obj,
        sourceFile,
      } as any;
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

    const { isDisposable, isAsyncDisposable } = implementationSymbol && registrationType !== 'factory'
      ? this.detectDisposable(implementationSymbol)
      : { isDisposable: false, isAsyncDisposable: false };

    const definition: ServiceDefinition = {
      tokenId,
      implementationSymbol,
      registrationNode: obj,
      type: registrationType,
      lifecycle,
      isInterfaceToken,
      factorySource: registrationType === 'factory' && providerNode ? providerNode.getText(sourceFile) : undefined,
      isScoped,
      isAsync: isAsync || undefined,
      isDisposable: isDisposable || undefined,
      isAsyncDisposable: isAsyncDisposable || undefined,
    };

    return {
      definition,
      node: obj,
      tokenText,
      isScoped,
      isMulti,
    };
  }

  /** Detects whether a class symbol implements dispose(): void or dispose(): Promise<void>. */
  private detectDisposable(symbol: ts.Symbol): { isDisposable: boolean; isAsyncDisposable: boolean } {
    if (symbol.flags & TSContext.ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    const type = this.checker.getDeclaredTypeOfSymbol(symbol);
    const disposeMember = type.getProperty('dispose');
    if (!disposeMember) return { isDisposable: false, isAsyncDisposable: false };

    const disposeType = this.checker.getTypeOfSymbol(disposeMember);
    const signatures = disposeType.getCallSignatures();
    if (signatures.length === 0) return { isDisposable: false, isAsyncDisposable: false };

    const returnType = this.checker.getReturnTypeOfSignature(signatures[0]);
    const isAsync = this.checker.typeToString(returnType).startsWith('Promise');

    return { isDisposable: !isAsync, isAsyncDisposable: isAsync };
  }

  private isAsyncFunction(node: ts.Expression): boolean {
    if (!TSContext.ts.isArrowFunction(node) && !TSContext.ts.isFunctionExpression(node)) {
      return false;
    }
    const fn = node as ts.ArrowFunction | ts.FunctionExpression;
    return fn.modifiers?.some(m => m.kind === TSContext.ts.SyntaxKind.AsyncKeyword) ?? false;
  }

  private checkPrimitiveTokenForValue(
    tokenNode: ts.Expression,
    injectionObj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): AnalysisError | null {
    if (!TSContext.ts.isCallExpression(tokenNode)) return null;
    if (!tokenNode.typeArguments || tokenNode.typeArguments.length === 0) return null;

    const typeArg = tokenNode.typeArguments[0];
    const type = this.checker.getTypeFromTypeNode(typeArg);
    const typeName = this.checker.typeToString(type);

    const primitives = ['string', 'number', 'boolean', 'symbol', 'bigint'];
    if (!primitives.includes(typeName)) return null;

    return {
      type: 'type-mismatch',
      message:
        `useValue cannot be used with primitive type '${typeName}'. ` +
        `Use useProperty<${typeName}>(TargetClass, 'paramName') instead — ` +
        `it creates a unique token bound to a specific constructor parameter.`,
      node: injectionObj,
      sourceFile,
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

  private getSymbolForNode(node: ts.Node): ts.Symbol | undefined {
    return this.checker.getSymbolAtLocation(node);
  }

  private getExtendsRefs(configObj: ts.ObjectLiteralExpression): string[] {
    const refs: string[] = [];
    const extendsProp = this.findProperty(configObj, 'extends');

    if (extendsProp && TSContext.ts.isArrayLiteralExpression(extendsProp.initializer)) {
      for (const element of extendsProp.initializer.elements) {
        if (TSContext.ts.isIdentifier(element)) {
          refs.push(element.text);
        }
      }
    }

    return refs;
  }

  private getUseContainerRef(configObj: ts.ObjectLiteralExpression): string | null {
    const useContainerProp = this.findProperty(configObj, 'useContainer');

    if (useContainerProp && TSContext.ts.isIdentifier(useContainerProp.initializer)) {
      return useContainerProp.initializer.text;
    }

    return null;
  }

  private getContainerName(configObj: ts.ObjectLiteralExpression): string | undefined {
    const nameProp = this.findProperty(configObj, 'name');

    if (nameProp && TSContext.ts.isStringLiteral(nameProp.initializer)) {
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
      TSContext.ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      TSContext.ts.isCallExpression(declaration.initializer)
    ) {
      const callExpr = declaration.initializer;

      // Check if it's declareContainerTokens
      if (
        TSContext.ts.isIdentifier(callExpr.expression) &&
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

      if (TSContext.ts.isIdentifier(node) && node.text === name) {
        result = node;
        return;
      }

      TSContext.ts.forEachChild(node, visit);
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
        TSContext.ts.isPropertyAssignment(prop) &&
        TSContext.ts.isIdentifier(prop.name) &&
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
    const fileName = basename(sourceFile.fileName, '.ts');
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
      if (TSContext.ts.isPropertyAssignment(prop) &&
          TSContext.ts.isIdentifier(prop.name) &&
          prop.name.text === 'name') {

        // The value should be a string literal
        if (TSContext.ts.isStringLiteral(prop.initializer)) {
          return prop.initializer.text;
        }
      }
    }

    return undefined;
  }
}
