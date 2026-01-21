import * as ts from 'typescript';
import type { ConfigGraph, ServiceDefinition, InjectionInfo, ConfigType, TokenId } from '../types';
import { generateTokenId } from '../Analyzer';

/**
 * Interface for collecting configurations from source files.
 */
export interface IConfigCollector {
  /** Collect all configs from the program */
  collect(): Map<string, ConfigGraph>;
}

/**
 * Collects defineBuilderConfig and definePartialConfig calls from the program.
 */
export class ConfigCollector implements IConfigCollector {
  constructor(
    private program: ts.Program,
    private checker: ts.TypeChecker
  ) {}

  collect(): Map<string, ConfigGraph> {
    const configs = new Map<string, ConfigGraph>();

    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitNode(sourceFile, sourceFile, configs);
    }

    return configs;
  }

  private visitNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    configs: Map<string, ConfigGraph>
  ): void {
    if (ts.isCallExpression(node)) {
      const config = this.tryParseConfig(node, sourceFile);
      if (config) {
        configs.set(config.name, config);
      }
    }

    ts.forEachChild(node, (child) => this.visitNode(child, sourceFile, configs));
  }

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

  private resolveTokenId(tokenNode: ts.Expression): TokenId | null {
    // Resolve variable references
    const resolved = this.resolveToInitializer(tokenNode);
    const node = resolved || tokenNode;

    // Case: useInterface<I>()
    if (ts.isCallExpression(node) && this.isUseInterfaceCall(node)) {
      return this.extractInterfaceTokenId(node);
    }

    // Case: useProperty<T>(Class, 'prop')
    if (ts.isCallExpression(node) && this.isUsePropertyCall(node)) {
      return this.extractPropertyTokenId(node);
    }

    // Case: Class (direct reference)
    const type = this.checker.getTypeAtLocation(tokenNode);
    return this.getTypeId(type);
  }

  private resolveToInitializer(node: ts.Expression): ts.Expression | null {
    // Case 1: Simple identifier (e.g., myToken)
    if (ts.isIdentifier(node)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      if (!symbol) return null;

      const declarations = symbol.getDeclarations();
      if (!declarations || declarations.length === 0) return null;

      const decl = declarations[0];
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        return decl.initializer;
      }

      return null;
    }

    // Case 2: Property access (e.g., TOKENS.IRequestContext)
    if (ts.isPropertyAccessExpression(node)) {
      const objectSymbol = this.checker.getSymbolAtLocation(node.expression);
      if (!objectSymbol) return null;

      const declarations = objectSymbol.getDeclarations();
      if (!declarations || declarations.length === 0) return null;

      const decl = declarations[0];
      if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        // Find the property in the object literal
        const propName = node.name.text;
        for (const prop of decl.initializer.properties) {
          if (ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === propName) {
            return prop.initializer;
          }
        }
      }

      return null;
    }

    return null;
  }

  private isUseInterfaceCall(node: ts.Expression): boolean {
    if (!ts.isCallExpression(node)) return false;
    const expr = node.expression;
    return ts.isIdentifier(expr) && expr.text === 'useInterface';
  }

  private isUsePropertyCall(node: ts.Expression): boolean {
    if (!ts.isCallExpression(node)) return false;
    const expr = node.expression;
    return ts.isIdentifier(expr) && expr.text === 'useProperty';
  }

  private extractInterfaceTokenId(node: ts.CallExpression): TokenId {
    const typeArgs = node.typeArguments;
    if (!typeArgs || typeArgs.length === 0) {
      return 'UnknownInterface';
    }

    const typeArg = typeArgs[0];
    const type = this.checker.getTypeAtLocation(typeArg);
    const typeId = this.getTypeId(type);

    return `useInterface<${typeId}>()`;
  }

  private extractPropertyTokenId(node: ts.CallExpression): TokenId {
    const args = node.arguments;
    if (args.length < 2) return 'UnknownProperty';

    const className = args[0].getText();
    const propName = ts.isStringLiteral(args[1]) ? args[1].text : args[1].getText();

    return `useProperty<${className}>('${propName}')`;
  }

  private getTypeId(type: ts.Type): string {
    const symbol = type.getSymbol() || type.aliasSymbol;
    if (!symbol) {
      return this.checker.typeToString(type);
    }

    // Use the same ID generation as Analyzer for consistency
    const declarations = symbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const sourceFile = declarations[0].getSourceFile();
      return generateTokenId(symbol, sourceFile);
    }

    return symbol.getName();
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
        const tokenId = this.getTypeId(propType);
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
}
