import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { TokenId, AnalysisError } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';

export type ParsedRegistrationType = 'explicit' | 'autowire' | 'factory' | 'value';

export interface ParsedInjection {
  readonly __kind: 'parsed';
  tokenNode: ts.Expression;
  resolvedTokenNode: ts.Expression;
  providerNode?: ts.Expression;
  tokenId: TokenId;
  tokenText: string;
  tokenSymbol?: ts.Symbol;
  isInterfaceToken: boolean;
  isValueToken: boolean;
  isMulti: boolean;
  isScoped: boolean;
  lifecycle: 'singleton' | 'transient';
  valueSource?: string;
  useFactory: boolean;
  factorySource?: string;
  isAsync: boolean;
  implementationSymbol?: ts.Symbol;
  registrationType: ParsedRegistrationType;
  isDisposable: boolean;
  isAsyncDisposable: boolean;
  implementationLocalName?: string;
  tokenLocalName?: string;
}

/**
 * Shared injection parser for both ConfigParser (code generation path) and
 * ConfigCollector (LSP modular path). Extracts and validates a single injection
 * object literal, returning a ParsedInjection or an AnalysisError if invalid.
 */
export class InjectionParser {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly tokenResolverService: TokenResolverService
  ) {}

  parse(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): ParsedInjection | AnalysisError | null {
    // 1. Extract properties
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
        case 'token': tokenNode = prop.initializer; break;
        case 'provider': providerNode = prop.initializer; break;
        case 'lifecycle':
          if (TSContext.ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'transient') {
            lifecycle = 'transient';
          }
          break;
        case 'useFactory':
          // `.kind` comparison is used because TypeScript has no `isTrue()` type-guard helper.
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) useFactory = true;
          break;
        case 'scoped':
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) isScoped = true;
          break;
        case 'useValue': valueNode = prop.initializer; break;
        case 'multi':
          if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) isMulti = true;
          break;
      }
    }

    if (!tokenNode) return null;

    // 2. Auto-detect factory if provider is a function literal
    if (
      providerNode &&
      (TSContext.ts.isArrowFunction(providerNode) || TSContext.ts.isFunctionExpression(providerNode))
    ) {
      useFactory = true;
    }

    // 3. Resolve token ID and determine token type
    const resolvedTokenNode = this.tokenResolverService.resolveToInitializer(tokenNode) ?? tokenNode;
    let tokenId: TokenId | null = null;
    let tokenSymbol: ts.Symbol | undefined;
    let isInterfaceToken = false;
    let isValueToken = false;

    if (this.tokenResolverService.isUseInterfaceCall(resolvedTokenNode)) {
      tokenId = this.tokenResolverService.extractInterfaceTokenId(resolvedTokenNode);
      isInterfaceToken = true;
    } else if (this.tokenResolverService.isUsePropertyCall(resolvedTokenNode)) {
      tokenId = this.tokenResolverService.extractPropertyTokenId(resolvedTokenNode);
      isValueToken = true;
      if (!providerNode) {
        return {
          type: 'type-mismatch',
          message: `useProperty() requires a provider (factory). Add 'provider: () => ...' to the registration.`,
          node: obj,
          sourceFile,
        };
      }
      useFactory = true;
    } else {
      const tokenType = this.checker.getTypeAtLocation(tokenNode);
      tokenId = this.tokenResolverService.getTypeIdFromConstructor(tokenType);
      if (TSContext.ts.isIdentifier(tokenNode)) {
        tokenSymbol = this.checker.getSymbolAtLocation(tokenNode) ?? undefined;
      }
    }

    if (!tokenId) return null;

    const tokenText = tokenNode.getText(sourceFile);

    // 4. useValue path
    if (valueNode) {
      if (isInterfaceToken) {
        const primitiveError = this.checkPrimitiveTokenForValue(resolvedTokenNode, obj, sourceFile);
        if (primitiveError) return primitiveError;
      } else {
        // useValue with class token is not supported (bug fix: was missing in ConfigCollector)
        return {
          type: 'type-mismatch',
          message: `useValue cannot be used with a class token. Use provider: ${tokenText} to register a class, or useInterface<T>() with useValue for an interface token.`,
          node: obj,
          sourceFile,
        };
      }

      return {
        __kind: 'parsed',
        tokenNode,
        resolvedTokenNode,
        tokenId,
        tokenText,
        tokenSymbol,
        isInterfaceToken,
        isValueToken: false,
        isMulti,
        isScoped,
        lifecycle: 'singleton',
        valueSource: valueNode.getText(sourceFile),
        useFactory: false,
        isAsync: false,
        registrationType: 'value',
        isDisposable: false,
        isAsyncDisposable: false,
      };
    }

    // 5. Async factory detection and transient validation
    const isAsync = useFactory && providerNode ? this.isAsyncFunction(providerNode) : false;
    if (isAsync && lifecycle === 'transient') {
      return {
        type: 'type-mismatch',
        message: `Async factory for '${tokenText}' cannot use lifecycle: 'transient'. Async factories are pre-initialized once in initialize() and must be singletons. Remove lifecycle: 'transient' or make the factory synchronous.`,
        node: obj,
        sourceFile,
      };
    }

    // 6. Determine registration type
    let registrationType: ParsedRegistrationType;
    if (useFactory) {
      registrationType = 'factory';
    } else if (providerNode) {
      registrationType = 'explicit';
    } else {
      registrationType = 'autowire';
    }

    // 7. Resolve implementation symbol
    let implementationSymbol: ts.Symbol | undefined;
    if (registrationType !== 'factory') {
      if (providerNode) {
        implementationSymbol = this.checker.getSymbolAtLocation(providerNode) ?? undefined;
      } else if (TSContext.ts.isIdentifier(tokenNode)) {
        implementationSymbol = this.checker.getSymbolAtLocation(tokenNode) ?? undefined;
      }
    }

    // 8. Detect disposable interface
    const { isDisposable, isAsyncDisposable } = implementationSymbol
      ? this.detectDisposable(implementationSymbol)
      : { isDisposable: false, isAsyncDisposable: false };

    const factorySource =
      registrationType === 'factory' && providerNode ? providerNode.getText(sourceFile) : undefined;

    // 9. Capture local identifier names for default exports.
    // When `import Auth from './AuthService'` is used, getSymbolAtLocation returns an alias
    // whose getName() is "Auth". ConfigParser/ConfigCollector then call resolveSymbol() which
    // follows the alias chain to the 'default' export symbol (getName() === "default"), losing
    // the local binding name. We capture it here while we still have the original AST nodes.
    const implementationLocalName = this.resolveDefaultLocalName(
      implementationSymbol,
      providerNode ?? (TSContext.ts.isIdentifier(tokenNode) ? tokenNode : undefined)
    );
    const tokenLocalName = this.resolveDefaultLocalName(
      tokenSymbol,
      TSContext.ts.isIdentifier(tokenNode) ? tokenNode : undefined
    );

    return {
      __kind: 'parsed',
      tokenNode,
      resolvedTokenNode,
      providerNode,
      tokenId,
      tokenText,
      tokenSymbol,
      isInterfaceToken,
      isValueToken,
      isMulti,
      isScoped,
      lifecycle,
      valueSource: undefined,
      useFactory,
      factorySource,
      isAsync,
      implementationSymbol,
      registrationType,
      isDisposable,
      isAsyncDisposable,
      implementationLocalName,
      tokenLocalName,
    };
  }

  private checkPrimitiveTokenForValue(
    tokenNode: ts.Expression,
    registrationNode: ts.ObjectLiteralExpression,
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
      node: registrationNode,
      sourceFile,
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
    if (!TSContext.ts.isArrowFunction(node) && !TSContext.ts.isFunctionExpression(node)) return false;
    const fn = node as ts.ArrowFunction | ts.FunctionExpression;
    return fn.modifiers?.some(m => m.kind === TSContext.ts.SyntaxKind.AsyncKeyword) ?? false;
  }

  /**
   * Returns the local identifier name for a symbol if it is an alias for a 'default' export.
   * After ConfigParser/ConfigCollector call resolveSymbol(), the alias chain is followed and the
   * local binding name (e.g. "Auth" from `import Auth from './Foo'`) is replaced by "default".
   * This method captures the local name while the original AST node is still available.
   */
  private resolveDefaultLocalName(
    symbol: ts.Symbol | undefined,
    identifierNode: ts.Expression | undefined
  ): string | undefined {
    if (!symbol || !identifierNode || !TSContext.ts.isIdentifier(identifierNode)) return undefined;
    if (!(symbol.flags & TSContext.ts.SymbolFlags.Alias)) return undefined;

    const aliased = this.checker.getAliasedSymbol(symbol);
    if (aliased.getName() !== 'default') return undefined;

    return (identifierNode as ts.Identifier).text;
  }
}
