import * as ts from 'typescript';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from './types';

/**
 * Error thrown when a duplicate registration is detected.
 * Includes the position of the duplicate registration node.
 */
export class DuplicateRegistrationError extends Error {
  constructor(
    message: string,
    public readonly node: ts.Node,
    public readonly sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'DuplicateRegistrationError';
  }
}

/**
 * Error thrown when a provider type is incompatible with the token type.
 * Includes the position of the registration node.
 */
export class TypeMismatchError extends Error {
  constructor(
    message: string,
    public readonly node: ts.Node,
    public readonly sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'TypeMismatchError';
  }
}

/**
 * Generates a unique, deterministic Token ID for a symbol.
 * Uses the symbol name and a short hash of its relative file path.
 */
export function generateTokenId(symbol: ts.Symbol, sourceFile: ts.SourceFile): string {
  const name = symbol.getName();

  // 1. Get relative path to ensure consistency across environments (CI vs Local)
  let relativePath = path.relative(process.cwd(), sourceFile.fileName);

  // 2. Normalize to POSIX style (forward slashes) for Windows consistency
  relativePath = relativePath.split(path.sep).join('/');

  // 3. Create a deterministic short hash (MD5 hex, 8 chars)
  const hash = crypto
    .createHash('md5')
    .update(relativePath)
    .digest('hex')
    .substring(0, 8);

  return `${name}_${hash}`;
}

/**
 * Analyzes TypeScript source code to extract the dependency injection graph.
 *
 * This class uses the TypeScript Compiler API to:
 * 1. Locate `createContainer` calls.
 * 2. Parse the fluent chain of `bind` and `register` calls.
 * 3. Resolve symbols and types for services and their dependencies.
 * 4. Build a `DependencyGraph` representing the system.
 */
export class Analyzer {
  private program: ts.Program;
  private checker: ts.TypeChecker;
  /** Set of variable names that are parent containers (should not be added to main graph) */
  private parentContainerNames = new Set<string>();

  /**
   * Creates a new Analyzer instance.
   * @param program - The TypeScript Program instance containing the source files to analyze.
   */
  constructor(program: ts.Program) {
    this.program = program;
    this.checker = program.getTypeChecker();
  }

  /**
   * Extracts the dependency graph from the program's source files.
   *
   * It scans all non-declaration source files for container configurations.
   *
   * @returns A `DependencyGraph` containing all registered services and their dependencies.
   */
  public extract(): DependencyGraph {
    const graph: DependencyGraph = {
      nodes: new Map(),
      roots: [],
      buildArguments: [],
      errors: [], // Initialize error collection
    };

    // First pass: identify all parent containers (useContainer references)
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.identifyParentContainers(sourceFile);
    }

    // Second pass: parse all containers except parents
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitNode(sourceFile, graph);
    }

    // After extracting all nodes, resolve dependencies for each
    this.resolveAllDependencies(graph);

    // Return the graph with collected errors
    // CLI and Generator will check graph.errors and throw if needed
    return graph;
  }

  /**
   * First pass: identify containers used as parents so we can skip them in visitNode.
   */
  private identifyParentContainers(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'useContainer' &&
        ts.isIdentifier(node.initializer)) {
      this.parentContainerNames.add(node.initializer.text);
    }
    ts.forEachChild(node, (child) => this.identifyParentContainers(child));
  }

  /**
   * Visits an AST node to find container calls.
   * @param node - The AST node to visit.
   * @param graph - The graph to populate.
   */
  private visitNode(node: ts.Node, graph: DependencyGraph): void {
    if (ts.isCallExpression(node)) {
      if (this.isDefineBuilderConfigCall(node)) {
        // Check if this is a parent container (should be skipped)
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          if (this.parentContainerNames.has(parent.name.text)) {
            // Skip - this container is used as a parent, already processed
            return;
          }
          // Extract the exported variable name
          graph.exportedVariableName = parent.name.text;

          // Find the VariableStatement to get insertion position and export modifier
          let current: ts.Node = parent;
          while (current && !ts.isVariableStatement(current)) {
            current = current.parent;
          }
          if (current && ts.isVariableStatement(current)) {
            // Use getStart() to exclude leading comments - we want to preserve them
            graph.variableStatementStart = current.getStart();

            // Detect export modifier
            const modifiers = ts.canHaveModifiers(current) ? ts.getModifiers(current) : undefined;
            if (modifiers) {
              const hasExport = modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
              const hasDefault = modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);

              if (hasExport && hasDefault) {
                graph.variableExportModifier = 'export default';
              } else if (hasExport) {
                graph.variableExportModifier = 'export';
              }
            }
          }
        }
        // Store the position of defineBuilderConfig call for replacement
        graph.defineBuilderConfigStart = node.getStart();
        graph.defineBuilderConfigEnd = node.getEnd();
        this.parseBuilderConfig(node, graph);
      }
    }

    ts.forEachChild(node, (child) => this.visitNode(child, graph));
  }

  private isDefineBuilderConfigCall(node: ts.CallExpression): boolean {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      return expression.text === 'defineBuilderConfig';
    }
    return false;
  }

  private parseBuilderConfig(node: ts.CallExpression, graph: DependencyGraph): void {
    const args = node.arguments;
    if (args.length < 1) return;

    const configObj = args[0];
    if (!ts.isObjectLiteralExpression(configObj)) return;

    // Parse 'name' property
    const nameProp = configObj.properties.find(p =>
        p.name && ts.isIdentifier(p.name) && p.name.text === 'name'
    );

    if (nameProp && ts.isPropertyAssignment(nameProp) && ts.isStringLiteral(nameProp.initializer)) {
        graph.containerName = nameProp.initializer.text;
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
        this.parseExtendsArray(extendsProp.initializer, graph);
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
            // Try to extract tokens from the parent container
            this.extractParentContainerTokens(containerExpr, graph);
        }
    }
  }

  /**
   * Extracts tokens provided by a parent container.
   * Handles both NeoSyringe containers (defineBuilderConfig) and
   * declared legacy containers (declareContainerTokens).
   */
  private extractParentContainerTokens(containerIdentifier: ts.Identifier, graph: DependencyGraph): void {
      const symbol = this.checker.getSymbolAtLocation(containerIdentifier);
      if (!symbol) return;

      // Mark this container as a parent so visitNode skips it
      this.parentContainerNames.add(containerIdentifier.text);

      const resolvedSymbol = this.resolveSymbol(symbol);
      const declaration = resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0];
      if (!declaration) return;

      // Case 1: const parent = defineBuilderConfig({...}) - NeoSyringe container
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const init = declaration.initializer;

          if (ts.isCallExpression(init)) {
              // Check if it's defineBuilderConfig
              if (this.isDefineBuilderConfigCall(init) || this.isDefinePartialConfigCall(init)) {
                  // Parse the parent config to extract its tokens
                  const parentGraph: DependencyGraph = { nodes: new Map(), roots: [] };
                  this.parseBuilderConfig(init, parentGraph);

                  // Add all parent tokens to parentProvidedTokens
                  for (const tokenId of parentGraph.nodes.keys()) {
                      graph.parentProvidedTokens!.add(tokenId);
                  }

                  // Also inherit parent's parent tokens (transitive)
                  if (parentGraph.parentProvidedTokens) {
                      for (const tokenId of parentGraph.parentProvidedTokens) {
                          graph.parentProvidedTokens!.add(tokenId);
                      }
                  }
                  return;
              }

              // Check if it's declareContainerTokens<{...}>()
              if (this.isDeclareContainerTokensCall(init)) {
                  this.extractDeclaredTokens(init, graph);
                  return;
              }
          }
      }
  }

  /**
   * Checks if a call expression is declareContainerTokens<T>().
   */
  private isDeclareContainerTokensCall(node: ts.CallExpression): boolean {
      if (ts.isIdentifier(node.expression)) {
          return node.expression.text === 'declareContainerTokens';
      }
      return false;
  }

  /**
   * Extracts tokens from declareContainerTokens<{ Token: Type }>().
   * The type argument contains the token names.
   */
  private extractDeclaredTokens(node: ts.CallExpression, graph: DependencyGraph): void {
      if (!node.typeArguments || node.typeArguments.length === 0) return;

      const typeArg = node.typeArguments[0];
      const type = this.checker.getTypeFromTypeNode(typeArg);

      // Get properties of the type (e.g., { AuthService: AuthService, UserRepo: UserRepo })
      const properties = type.getProperties();
      for (const prop of properties) {
          const propType = this.checker.getTypeOfSymbol(prop);
          if (propType) {
              const tokenId = this.getTypeId(propType);
              graph.parentProvidedTokens!.add(tokenId);
          } else {
              graph.parentProvidedTokens!.add(prop.getName());
          }
      }
  }

  private parseExtendsArray(arrayLiteral: ts.ArrayLiteralExpression, graph: DependencyGraph): void {
      for (const element of arrayLiteral.elements) {
          if (ts.isIdentifier(element)) {
              this.parsePartialConfig(element, graph);
          }
      }
  }

  private parsePartialConfig(identifier: ts.Identifier, graph: DependencyGraph): void {
      const symbol = this.checker.getSymbolAtLocation(identifier);
      if (!symbol) return;

      const resolvedSymbol = this.resolveSymbol(symbol);
      const declaration = resolvedSymbol.valueDeclaration ?? resolvedSymbol.declarations?.[0];

      if (!declaration) return;

      // We expect the declaration to be 'const config = definePartialConfig({...})'
      // VariableDeclaration -> CallExpression
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isCallExpression(declaration.initializer)) {
          const callExpr = declaration.initializer;
          if (this.isDefinePartialConfigCall(callExpr)) {
              this.parseBuilderConfig(callExpr, graph); // Recursive reuse!
          }
      }

      // Handle ExportSpecifier (imported partials)
      if (ts.isExportSpecifier(declaration)) {
          // This is harder. We need to find the aliased symbol's declaration.
          // resolveSymbol should have handled aliases.
          // If we are here, maybe we need to dig deeper into the aliased symbol?
      }
  }

  private isDefinePartialConfigCall(node: ts.CallExpression): boolean {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      return expression.text === 'definePartialConfig';
    }
    return false;
  }

  private parseInjectionsArray(arrayLiteral: ts.ArrayLiteralExpression, graph: DependencyGraph): void {
      for (const element of arrayLiteral.elements) {
          if (ts.isObjectLiteralExpression(element)) {
              this.parseInjectionObject(element, graph);
          }
      }
  }

  private parseInjectionObject(obj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
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
              // Check if useFactory: true
              if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
                  useFactory = true;
              }
          } else if (prop.name.text === 'scoped') {
              // Check if scoped: true
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
      const resolved = this.resolveToInitializer(tokenNode);
      if (resolved) {
          resolvedTokenNode = resolved;
      }

      // 1. Resolve Token ID
      if (ts.isCallExpression(resolvedTokenNode) && this.isUseInterfaceCall(resolvedTokenNode)) {
          // Case: token: useInterface<I>()
          tokenId = this.extractInterfaceTokenId(resolvedTokenNode);
          type = 'explicit';
          isInterfaceToken = true;
      } else if (ts.isCallExpression(resolvedTokenNode) && this.isUsePropertyCall(resolvedTokenNode)) {
          // Case: token: useProperty<T>(Class, 'paramName') or variable referencing it
          const propertyInfo = this.extractPropertyTokenId(resolvedTokenNode);
          tokenId = propertyInfo.tokenId;
          type = 'explicit';
          isValueToken = true;
          // Property tokens MUST have a factory provider
          if (!providerNode) {
              throw new Error(`useProperty(${propertyInfo.className}, '${propertyInfo.paramName}') requires a provider (factory).`);
          }
          useFactory = true;
      } else {
          // Case: token: Class
          const tokenType = this.checker.getTypeAtLocation(tokenNode);
          tokenId = this.getTypeIdFromConstructor(tokenType);
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
                  // Get the original token text for better readability
                  const tokenText = tokenNode.getText(sourceFile);
                  // Collect error instead of throwing
                  if (!graph.errors) graph.errors = [];
                  graph.errors.push({
                    type: 'duplicate',
                    message: `Duplicate registration: '${tokenText}' is already registered.`,
                    node: obj,
                    sourceFile: sourceFile
                  });
                  // Continue processing to find more errors
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
          // Only valid if token was NOT useInterface
          if (type === 'explicit' && !providerNode) {
              // This is actually invalid for interfaces, but maybe valid if token is Class?
              // { token: Class } -> Autowire
              if (ts.isIdentifier(tokenNode)) {
                 implementationSymbol = this.checker.getSymbolAtLocation(tokenNode);
                 type = 'autowire';
              }
          } else {
              // providerNode might be missing, assume token is impl
               if (ts.isIdentifier(tokenNode)) {
                 implementationSymbol = this.checker.getSymbolAtLocation(tokenNode);
                 type = 'autowire';
              }
          }
      }

      if (tokenId && implementationSymbol) {
         // Check for duplicate - allow if scoped: true (intentional override)
         if (graph.nodes.has(tokenId) && !isScoped) {
              const sourceFile = obj.getSourceFile();
              // Get the original token text for better readability
              const tokenText = tokenNode.getText(sourceFile);
              // Collect error instead of throwing
              if (!graph.errors) graph.errors = [];
              graph.errors.push({
                type: 'duplicate',
                message: `Duplicate registration: '${tokenText}' is already registered.`,
                node: obj,
                sourceFile: sourceFile
              });
              // Continue processing to find more errors
              return;
         }

         // Check type compatibility between token and provider (only for explicit registrations)
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
             isInterfaceToken: isInterfaceToken || (ts.isCallExpression(tokenNode) && this.isUseInterfaceCall(tokenNode)),
             isScoped
         };
         graph.nodes.set(tokenId, { service: definition, dependencies: [] });
      }
  }

  private isUseInterfaceCall(node: ts.CallExpression): boolean {
      if (ts.isIdentifier(node.expression)) {
          return node.expression.text === 'useInterface';
      }
      return false;
  }

  private isUsePropertyCall(node: ts.CallExpression): boolean {
      if (ts.isIdentifier(node.expression)) {
          return node.expression.text === 'useProperty';
      }
      return false;
  }

  /**
   * Resolves a node to its original initializer expression.
   * Handles identifiers, property access, imports, and unwraps type assertions/casts.
   */
  private resolveToInitializer(node: ts.Expression): ts.Expression | undefined {
      let expr = node;
      while (
          ts.isParenthesizedExpression(expr) ||
          ts.isAsExpression(expr) ||
          ts.isTypeAssertionExpression(expr) ||
          (ts.isSatisfiesExpression && ts.isSatisfiesExpression(expr))
      ) {
          expr = expr.expression;
      }

      if (ts.isCallExpression(expr)) {
          return expr;
      }

      if (ts.isIdentifier(expr)) {
          return this.resolveIdentifierToInitializer(expr);
      }

      if (ts.isPropertyAccessExpression(expr)) {
          return this.resolvePropertyAccessToInitializer(expr);
      }

      return undefined;
  }

  private resolveIdentifierToInitializer(identifier: ts.Identifier): ts.Expression | undefined {
      const symbol = this.checker.getSymbolAtLocation(identifier);
      if (!symbol) return undefined;

      const resolvedSymbol = this.resolveSymbol(symbol);
      const declarations = resolvedSymbol.getDeclarations();
      if (!declarations || declarations.length === 0) return undefined;

      for (const decl of declarations) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
              return this.resolveToInitializer(decl.initializer) ?? decl.initializer;
          }
      }
      return undefined;
  }

  private resolvePropertyAccessToInitializer(node: ts.PropertyAccessExpression): ts.Expression | undefined {
      const objectInitializer = this.resolveToInitializer(node.expression);

      if (objectInitializer && ts.isObjectLiteralExpression(objectInitializer)) {
          const propName = node.name.text;
          const prop = objectInitializer.properties.find(p =>
              p.name && ts.isIdentifier(p.name) && p.name.text === propName
          );

          if (prop && ts.isPropertyAssignment(prop)) {
              return this.resolveToInitializer(prop.initializer) ?? prop.initializer;
          }
      }
      return undefined;
  }

  /**
   * Validates that the provider type is compatible with the token type.
   * @param tokenNode - The token node (e.g., useInterface<ILogger>())
   * @param providerNode - The provider node (e.g., ConsoleLogger)
   * @param registrationNode - The full registration object for error reporting
   * @param graph - The dependency graph to collect errors
   */
  private validateTypeCompatibility(tokenNode: ts.Node, providerNode: ts.Node, registrationNode: ts.Node, graph: DependencyGraph): void {
      // Extract the interface type from useInterface<ILogger>()
      let tokenType: ts.Type | undefined;

      // Resolve tokenNode to the actual call expression if it's an identifier
      let resolvedTokenNode = tokenNode;
      if (ts.isExpression(tokenNode)) {
          const resolved = this.resolveToInitializer(tokenNode);
          if (resolved) {
              resolvedTokenNode = resolved;
          }
      }

      if (ts.isCallExpression(resolvedTokenNode) && this.isUseInterfaceCall(resolvedTokenNode)) {
          // Extract type from useInterface<T>()
          const typeArgs = resolvedTokenNode.typeArguments;
          if (typeArgs && typeArgs.length > 0) {
              tokenType = this.checker.getTypeFromTypeNode(typeArgs[0]);
          }
      }

      if (!tokenType) return;

      // Get the provider type (the class constructor)
      const providerType = this.checker.getTypeAtLocation(providerNode);

      // Get the instance type of the provider (what it returns when instantiated)
      let providerInstanceType: ts.Type | undefined;
      const constructSignatures = providerType.getConstructSignatures();
      if (constructSignatures.length > 0) {
          providerInstanceType = constructSignatures[0].getReturnType();
      } else {
          // Not a class, might be a value
          providerInstanceType = providerType;
      }

      if (!providerInstanceType) return;

      // Check if provider instance type is assignable to token type
      const isAssignable = this.checker.isTypeAssignableTo(providerInstanceType, tokenType);

      if (!isAssignable) {
          const sourceFile = registrationNode.getSourceFile();
          const tokenTypeName = this.checker.typeToString(tokenType);
          const providerTypeName = this.checker.typeToString(providerInstanceType);

          // Collect error instead of throwing
          if (!graph.errors) graph.errors = [];
          graph.errors.push({
            type: 'type-mismatch',
            message: `Type mismatch: Provider '${providerTypeName}' is not assignable to token type '${tokenTypeName}'.`,
            node: registrationNode,
            sourceFile: sourceFile
          });
      }
  }

  private extractPropertyTokenId(node: ts.CallExpression): { tokenId: TokenId; className: string; paramName: string } {
      // useProperty<T>(Class, 'paramName') - extract class name and param name
      if (node.arguments.length < 2) {
          throw new Error('useProperty requires two arguments: (Class, paramName)');
      }

      const classArg = node.arguments[0];
      const nameArg = node.arguments[1];

      if (!ts.isIdentifier(classArg)) {
          throw new Error('useProperty first argument must be a class identifier.');
      }

      if (!ts.isStringLiteral(nameArg)) {
          throw new Error('useProperty second argument must be a string literal.');
      }

      const className = classArg.text;
      const paramName = nameArg.text;

      return {
          tokenId: `PropertyToken:${className}.${paramName}`,
          className,
          paramName
      };
  }

  private extractInterfaceTokenId(node: ts.CallExpression): TokenId {
      if (!node.typeArguments || node.typeArguments.length === 0) {
          throw new Error('useInterface must have a type argument.');
      }
      const typeNode = node.typeArguments[0];
      const type = this.checker.getTypeFromTypeNode(typeNode);

      const symbol = type.getSymbol();
      if (!symbol) return 'AnonymousInterface';

      // Generate a unique ID based on file path and name to avoid collisions
      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
          const sourceFile = declarations[0].getSourceFile();
          return generateTokenId(symbol, sourceFile);
      }

      return symbol.getName();
  }

  private getTypeIdFromConstructor(type: ts.Type): TokenId {
     const constructSignatures = type.getConstructSignatures();
     let instanceType: ts.Type;

     if (constructSignatures.length > 0) {
         instanceType = constructSignatures[0].getReturnType();
     } else {
         instanceType = type;
     }
     return this.getTypeId(instanceType);
  }


  private extractScope(optionsNode: ts.ObjectLiteralExpression): 'singleton' | 'transient' {
      for (const prop of optionsNode.properties) {
          if (ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'scope' &&
              ts.isStringLiteral(prop.initializer)) {

              if (prop.initializer.text === 'transient') {
                  return 'transient';
              }
          }
      }
      return 'singleton';
  }

  /**
   * Resolves dependencies for all nodes in the graph.
   * @param graph - The dependency graph.
   */
  private resolveAllDependencies(graph: DependencyGraph): void {
      for (const node of graph.nodes.values()) {
          this.resolveDependencies(node, graph);
      }
  }

  /**
   * Resolves dependencies for a single service node by inspecting its constructor.
   * @param node - The dependency node to resolve.
   */
  private resolveDependencies(node: DependencyNode, graph: DependencyGraph): void {
      // Factories handle their own dependencies via container.resolve()
      // We don't need to analyze them statically
      if (node.service.isFactory || node.service.type === 'factory') {
          return;
      }

      const symbol = node.service.implementationSymbol;
      if (!symbol) return;

      const declarations = symbol.getDeclarations();
      if (!declarations || declarations.length === 0) return;

      const classDecl = declarations.find(d => ts.isClassDeclaration(d)) as ts.ClassDeclaration | undefined;
      if (!classDecl) return;

      const className = classDecl.name?.getText() ?? 'Anonymous';

      // Find constructor
      const constructor = classDecl.members.find(m => ts.isConstructorDeclaration(m)) as ts.ConstructorDeclaration | undefined;
      if (!constructor) return; // No constructor or default constructor

      for (const param of constructor.parameters) {
          const paramName = param.name.getText();
          const typeNode = param.type;

          if (!typeNode) {
              // Implicit any or inferred?
              // Without type annotation, we can't safely inject.
              continue;
          }

          const type = this.checker.getTypeFromTypeNode(typeNode);

          // 1. Check if there's a PropertyToken for this class.parameter
          const propertyTokenId = `PropertyToken:${className}.${paramName}`;
          if (graph.nodes.has(propertyTokenId)) {
              node.dependencies.push(propertyTokenId);
              continue;
          }

          // 2. Fallback: resolve by type (class/interface)
          const depTokenId = this.getTypeId(type);

          node.dependencies.push(depTokenId);
      }
  }

  /**
   * Generates a unique Token ID for a given Type.
   * Uses file path hash + name for consistency and collision avoidance.
   *
   * @param type - The TypeScript Type.
   * @returns A string identifier for the token.
   */
  private getTypeId(type: ts.Type): TokenId {
      const symbol = type.getSymbol();
      if (!symbol) {
          return this.checker.typeToString(type);
      }

      const name = symbol.getName();
      // Guard against internal property names leaking as Token IDs
      // This happens if resolution fails and we fall back to the InterfaceToken type itself
      if (name === '__type' || name === 'InterfaceToken' || name === '__brand') {
          return this.checker.typeToString(type);
      }

      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
          const sourceFile = declarations[0].getSourceFile();
          return generateTokenId(symbol, sourceFile);
      }

      // For classes and other types without distinct declarations, just use the name
      return symbol.getName();
  }

  /**
   * Resolves a symbol, following aliases if necessary.
   * @param symbol - The symbol to resolve.
   * @returns The resolved symbol.
   */
  private resolveSymbol(symbol: ts.Symbol): ts.Symbol {
      if (symbol.flags & ts.SymbolFlags.Alias) {
          return this.resolveSymbol(this.checker.getAliasedSymbol(symbol));
      }
      return symbol;
  }
}
