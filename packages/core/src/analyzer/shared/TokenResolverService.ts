import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { TokenId } from '../types';
import { HashUtils } from './HashUtils';

/**
 * Service for resolving TypeScript nodes to token IDs.
 *
 * This service centralizes token resolution logic that was previously duplicated
 * between Analyzer and ConfigCollector. It handles:
 * - Resolving variable references to their initializers
 * - Extracting token IDs from useInterface<T>() and useProperty<T>() calls
 * - Generating unique type IDs for TypeScript types
 *
 * @example
 * ```typescript
 * const service = new TokenResolverService(checker);
 *
 * // Resolve a variable reference
 * const resolved = service.resolveToInitializer(tokenNode);
 *
 * // Extract interface token ID
 * if (service.isUseInterfaceCall(resolved)) {
 *   const tokenId = service.extractInterfaceTokenId(resolved);
 * }
 * ```
 */
export class TokenResolverService {
  constructor(private checker: ts.TypeChecker) {}

  /**
   * Resolves a node to its original initializer expression.
   *
   * This method follows a chain of transformations to unwrap:
   * 1. Type assertions: `expr as Type`
   * 2. Parentheses: `(expr)`
   * 3. Satisfies expressions: `expr satisfies Type` (TypeScript 4.9+)
   * 4. Variable references: `myToken` → `useInterface<T>()`
   * 5. Property access: `TOKENS.MyToken` → `useInterface<T>()`
   * 6. Import aliases (follows through import statements)
   *
   * @param node - The expression node to resolve
   * @returns The resolved initializer, or undefined if not resolvable
   *
   * @example
   * ```typescript
   * // Direct call
   * token: useInterface<ILogger>()
   * // Returns: useInterface<ILogger>() node
   *
   * // Variable reference
   * const LoggerToken = useInterface<ILogger>();
   * token: LoggerToken
   * // Returns: useInterface<ILogger>() node
   *
   * // Property access
   * const TOKENS = { Logger: useInterface<ILogger>() };
   * token: TOKENS.Logger
   * // Returns: useInterface<ILogger>() node
   *
   * // Type assertion
   * token: (useInterface<ILogger>() as any)
   * // Returns: useInterface<ILogger>() node
   * ```
   */
  resolveToInitializer(node: ts.Expression): ts.Expression | undefined {
    let expr = node;

    // Unwrap type assertions, parentheses, and satisfies expressions
    while (
      TSContext.ts.isParenthesizedExpression(expr) ||
      TSContext.ts.isAsExpression(expr) ||
      TSContext.ts.isTypeAssertionExpression(expr) ||
      (TSContext.ts.isSatisfiesExpression && TSContext.ts.isSatisfiesExpression(expr))
    ) {
      expr = expr.expression;
    }

    // If already a call expression, return it
    if (TSContext.ts.isCallExpression(expr)) {
      return expr;
    }

    // Resolve simple identifiers
    if (TSContext.ts.isIdentifier(expr)) {
      return this.resolveIdentifierToInitializer(expr);
    }

    // Resolve property access (e.g., TOKENS.ILogger)
    if (TSContext.ts.isPropertyAccessExpression(expr)) {
      return this.resolvePropertyAccessToInitializer(expr);
    }

    return undefined;
  }

  /**
   * Resolves an identifier to its variable initializer.
   *
   * Follows the symbol to its declaration and returns the initializer expression.
   * Handles both local variables and imported symbols.
   *
   * @param identifier - Identifier node to resolve
   * @returns Initializer expression or undefined
   *
   * @example
   * ```typescript
   * // Variable declaration
   * const myToken = useInterface<ILogger>();
   * // Resolves: myToken → useInterface<ILogger>()
   *
   * // Imported token
   * import { LOGGER_TOKEN } from './tokens';
   * // Follows import and resolves to original definition
   * ```
   */
  private resolveIdentifierToInitializer(identifier: ts.Identifier): ts.Expression | undefined {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (!symbol) return undefined;

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return undefined;

    const decl = declarations[0];

    // Variable declaration: const x = ...
    if (TSContext.ts.isVariableDeclaration(decl) && decl.initializer) {
      return decl.initializer;
    }

    // Import specifier: import { x } from '...'
    if (TSContext.ts.isImportSpecifier(decl)) {
      const importDecl = decl.parent.parent.parent;
      if (TSContext.ts.isImportDeclaration(importDecl)) {
        // Follow the import to the original declaration
        const importSymbol = this.checker.getSymbolAtLocation(decl.name);
        if (importSymbol) {
          const aliasedSymbol = this.checker.getAliasedSymbol(importSymbol);
          const aliasedDeclarations = aliasedSymbol.getDeclarations();
          if (aliasedDeclarations && aliasedDeclarations.length > 0) {
            const aliasedDecl = aliasedDeclarations[0];
            if (TSContext.ts.isVariableDeclaration(aliasedDecl) && aliasedDecl.initializer) {
              return aliasedDecl.initializer;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Resolves a property access expression to its initializer.
   *
   * Handles cases like `TOKENS.ILogger` where TOKENS is an object literal
   * containing token definitions.
   *
   * @param propertyAccess - Property access expression to resolve
   * @returns Initializer expression or undefined
   *
   * @example
   * ```typescript
   * const TOKENS = {
   *   Logger: useInterface<ILogger>(),
   *   Database: useInterface<IDatabase>()
   * };
   *
   * token: TOKENS.Logger
   * // Resolves to: useInterface<ILogger>()
   * ```
   */
  private resolvePropertyAccessToInitializer(
    propertyAccess: ts.PropertyAccessExpression
  ): ts.Expression | undefined {
    const objectSymbol = this.checker.getSymbolAtLocation(propertyAccess.expression);
    if (!objectSymbol) return undefined;

    // Follow aliases (imports)
    const resolvedSymbol = objectSymbol.flags & TSContext.ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(objectSymbol)
      : objectSymbol;

    const declarations = resolvedSymbol.getDeclarations();
    if (!declarations || declarations.length === 0) return undefined;

    const decl = declarations[0];
    if (
      TSContext.ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      TSContext.ts.isObjectLiteralExpression(decl.initializer)
    ) {
      // Find the property in the object literal
      const propName = propertyAccess.name.text;
      for (const prop of decl.initializer.properties) {
        if (
          TSContext.ts.isPropertyAssignment(prop) &&
          TSContext.ts.isIdentifier(prop.name) &&
          prop.name.text === propName
        ) {
          return prop.initializer;
        }
      }
    }

    return undefined;
  }

  /**
   * Checks if a node is a useInterface<T>() call expression.
   *
   * @param node - Node to check
   * @returns True if node is useInterface call
   *
   * @example
   * ```typescript
   * const node = ...; // useInterface<ILogger>()
   * if (service.isUseInterfaceCall(node)) {
   *   const tokenId = service.extractInterfaceTokenId(node);
   * }
   * ```
   */
  isUseInterfaceCall(node: ts.Expression | undefined): node is ts.CallExpression {
    if (!node || !TSContext.ts.isCallExpression(node)) return false;
    const expr = node.expression;
    return TSContext.ts.isIdentifier(expr) && expr.text === 'useInterface';
  }

  /**
   * Checks if a node is a useProperty<T>() call expression.
   *
   * @param node - Node to check
   * @returns True if node is useProperty call
   *
   * @example
   * ```typescript
   * const node = ...; // useProperty<string>(MyClass, 'configPath')
   * if (service.isUsePropertyCall(node)) {
   *   const tokenId = service.extractPropertyTokenId(node);
   * }
   * ```
   */
  isUsePropertyCall(node: ts.Expression | undefined): node is ts.CallExpression {
    if (!node || !TSContext.ts.isCallExpression(node)) return false;
    const expr = node.expression;
    return TSContext.ts.isIdentifier(expr) && expr.text === 'useProperty';
  }

  /**
   * Extracts token ID from a useInterface<T>() call.
   *
   * Generates a unique ID based on the interface name and file location
   * to avoid collisions when multiple files define interfaces with the same name.
   *
   * @param node - useInterface call expression
   * @returns Token ID in format "InterfaceName_hash"
   * @throws {Error} If type argument is missing
   *
   * @example
   * ```typescript
   * // File: src/interfaces/ILogger.ts
   * useInterface<ILogger>()
   * // Returns: "ILogger_a1b2c3d4"
   *
   * // File: src/shared/ILogger.ts
   * useInterface<ILogger>()
   * // Returns: "ILogger_x9y8z7w6" (different file = different hash)
   * ```
   */
  extractInterfaceTokenId(node: ts.CallExpression): TokenId {
    if (!node.typeArguments || node.typeArguments.length === 0) {
      const sf = node.getSourceFile();
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      throw new Error(
        `useInterface() must have a type argument — e.g. useInterface<IMyService>(). ` +
        `Found at ${sf.fileName}:${line + 1}:${character + 1}`
      );
    }

    const typeNode = node.typeArguments[0];
    const type = this.checker.getTypeFromTypeNode(typeNode);

    // Return the type ID directly (e.g., "ILogger_a1b2c3d4")
    return this.getTypeId(type);
  }

  /**
   * Extracts token ID from a useProperty<T>(Class, 'paramName') call.
   *
   * Property tokens are used to inject primitive values (strings, numbers, etc.)
   * into specific class constructor parameters.
   *
   * @param node - useProperty call expression
   * @returns Token ID in format "PropertyToken:ClassName.paramName"
   * @throws {Error} If arguments are invalid
   *
   * @example
   * ```typescript
   * useProperty<string>(DatabaseService, 'connectionString')
   * // Returns: "PropertyToken:DatabaseService.connectionString"
   *
   * useProperty<number>(CacheService, 'ttl')
   * // Returns: "PropertyToken:CacheService.ttl"
   * ```
   */
  extractPropertyTokenId(node: ts.CallExpression): TokenId {
    if (node.arguments.length < 2) {
      throw new Error('useProperty requires two arguments: (Class, paramName)');
    }

    const classArg = node.arguments[0];
    const nameArg = node.arguments[1];

    if (!TSContext.ts.isIdentifier(classArg)) {
      throw new Error('useProperty first argument must be a class identifier.');
    }

    if (!TSContext.ts.isStringLiteral(nameArg)) {
      throw new Error('useProperty second argument must be a string literal.');
    }

    const className = classArg.text;
    const paramName = nameArg.text;

    // Use the original format for backward compatibility
    return `PropertyToken:${className}.${paramName}`;
  }

  /**
   * Generates a unique type ID for a TypeScript type.
   *
   * Uses the symbol name combined with a file hash to ensure uniqueness
   * across different files. Falls back to the type string representation
   * if no symbol is available.
   *
   * @param type - TypeScript type to generate ID for
   * @returns Unique type ID
   *
   * @example
   * ```typescript
   * // Interface in src/services/ILogger.ts
   * interface ILogger { }
   * const typeId = service.getTypeId(loggerType);
   * // Returns: "ILogger_a1b2c3d4"
   *
   * // Class in src/services/Logger.ts
   * class Logger { }
   * const typeId = service.getTypeId(loggerType);
   * // Returns: "Logger_x9y8z7w6"
   *
   * // Anonymous type
   * const typeId = service.getTypeId(anonymousType);
   * // Returns: "{ log: (msg: string) => void }" (type string)
   * ```
   */
  getTypeId(type: ts.Type): TokenId {
    const symbol = type.getSymbol() || type.aliasSymbol;

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
      return HashUtils.generateTokenId(symbol, sourceFile);
    }

    // For types without distinct declarations, just use the name
    return symbol.getName();
  }

  /**
   * Generates a unique type ID from a constructor type.
   *
   * Extracts the instance type from a constructor signature and generates
   * a token ID for it.
   *
   * @param type - Constructor type (e.g., typeof MyClass)
   * @returns Token ID for the instance type
   *
   * @example
   * ```typescript
   * // For: const token = MyClass
   * const type = checker.getTypeAtLocation(tokenNode);
   * const tokenId = service.getTypeIdFromConstructor(type);
   * // Returns: "MyClass_a1b2c3d4"
   * ```
   */
  getTypeIdFromConstructor(type: ts.Type): TokenId {
    const constructSignatures = type.getConstructSignatures();
    let instanceType: ts.Type;

    if (constructSignatures.length > 0) {
      instanceType = constructSignatures[0].getReturnType();
    } else {
      instanceType = type;
    }

    return this.getTypeId(instanceType);
  }

  /**
   * Resolves a token ID from any expression node.
   *
   * This is a convenience method that combines multiple resolution strategies:
   * 1. Resolve variable references to initializers
   * 2. Extract token ID from useInterface/useProperty calls
   * 3. Fall back to direct type resolution
   *
   * @param node - Expression node to resolve
   * @returns Token ID or null if not resolvable
   *
   * @example
   * ```typescript
   * // Works with all token types:
   * token: useInterface<ILogger>()          // → "useInterface<ILogger_abc>()"
   * token: UserService                      // → "UserService_def"
   * token: myTokenVariable                  // → resolves to actual token
   * token: TOKENS.Logger                    // → resolves to actual token
   * ```
   */
  resolveTokenId(tokenNode: ts.Expression): TokenId | null {
    // Resolve variable references
    const resolved = this.resolveToInitializer(tokenNode);
    const node = resolved || tokenNode;

    // Case: useInterface<I>()
    if (this.isUseInterfaceCall(node)) {
      return this.extractInterfaceTokenId(node);
    }

    // Case: useProperty<T>(Class, 'prop')
    if (this.isUsePropertyCall(node)) {
      return this.extractPropertyTokenId(node);
    }

    // Case: Class (direct reference)
    const type = this.checker.getTypeAtLocation(tokenNode);
    return this.getTypeIdFromConstructor(type);
  }

  /**
   * Produces a hash-based token ID from a ts.Type, matching the format used
   * when registering tokens in defineBuilderConfig (e.g. "IFoo_a1b2c3d4").
   * Used by DependencyAnalyzer to match constructor parameter types against
   * registered token IDs.
   */
  getHashedTokenIdFromType(type: ts.Type): string {
    const symbol = type.getSymbol();
    if (!symbol) return this.checker.typeToString(type);

    const name = symbol.getName();
    if (name === '__type' || name === 'InterfaceToken' || name === '__brand') {
      return this.checker.typeToString(type);
    }

    const declarations = symbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      return HashUtils.generateTokenId(symbol, declarations[0].getSourceFile());
    }

    return name;
  }

  /**
   * Resolves a symbol, following import aliases until the original declaration.
   * Centralises the alias-unwrapping logic used across Analyzer and resolvers.
   */
  resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    if (symbol.flags & TSContext.ts.SymbolFlags.Alias) {
      return this.resolveSymbol(this.checker.getAliasedSymbol(symbol));
    }
    return symbol;
  }
}
