import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { AliasTarget, TokenId, AnalysisError, CopiedBinding, FactoryDependency, SourceOrigin, TypeReference, ValidationMode } from '../types';
import { NeoTokenError } from '../errors/NeoTokenError';
import { TokenResolverService } from '../shared/TokenResolverService';
import { containerKeyFor } from '../shared/registrationGraph';
import { resolveNeoMarker } from '../shared/markerProvenance';

export type ParsedRegistrationType = 'explicit' | 'autowire' | 'factory' | 'value' | 'alias';

/**
 * The properties an alias cannot carry, in the order the message lists them. An alias owns nothing: the target keeps
 * its provider, its lifecycle, its owner and its dependencies.
 */
const ALIAS_FORBIDDEN = ['provider', 'useFactory', 'useValue', 'lifecycle', 'ownership', 'multi', 'dependencies'] as const;

/** File, start and length of the exact text `node.getText(sourceFile)` returns. */
function originOf(node: ts.Node, sourceFile: ts.SourceFile): SourceOrigin {
  const start = node.getStart(sourceFile);
  return { file: sourceFile.fileName, start, length: node.getEnd() - start };
}

/** The text of a plain identifier expression: the name the file binds. Anything else has no single binding. */
function identifierText(node: ts.Expression | undefined): string | undefined {
  return node !== undefined && TSContext.ts.isIdentifier(node) ? node.text : undefined;
}

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
  valueOrigin?: SourceOrigin;
  useFactory: boolean;
  factorySource?: string;
  factoryOrigin?: SourceOrigin;
  factoryBindings?: readonly CopiedBinding[];
  isAsync: boolean;
  implementationSymbol?: ts.Symbol;
  registrationType: ParsedRegistrationType;
  isDisposable: boolean;
  isAsyncDisposable: boolean;
  implementationLocalName?: string;
  tokenLocalName?: string;
  implementationBinding?: string;
  tokenBinding?: string;
  tokenType?: TypeReference;
  factoryDependencies?: FactoryDependency[];
  opaque?: boolean;
  dependenciesWarning?: AnalysisError;
  ownership?: 'owned' | 'borrowed';
  /** Only an alias has one: the token it stands for. */
  aliasTarget?: AliasTarget;
}

interface FactoryContract {
  readonly __factory: true;
  factoryDependencies: FactoryDependency[];
  opaque?: boolean;
  dependenciesWarning?: AnalysisError;
}

/**
 * The id of a token expression, or `null` when it names none (a literal, an object: `NEO_TOKEN_UNSUPPORTED`). An alias
 * reports that at its registration; a boundary error is not an alias matter and goes on.
 */
function namedToken(resolve: () => TokenId | null): TokenId | null {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof NeoTokenError && error.code === 'NEO_TOKEN_UNSUPPORTED') return null;
    throw error;
  }
}

/**
 * Shared injection parser for both ConfigParser (code generation path) and
 * ConfigCollector (LSP modular path). Extracts and validates a single injection
 * object literal, returning a ParsedInjection or an AnalysisError if invalid.
 */
export class InjectionParser {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly tokenResolverService: TokenResolverService,
    private readonly validation: ValidationMode = 'strict',
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
    let ownershipSeen = false;
    let ownershipText: string | undefined;
    let aliasNode: ts.Expression | undefined;
    const declared = new Set<string>();

    for (const prop of obj.properties) {
      if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;
      declared.add(prop.name.text);

      switch (prop.name.text) {
        case 'useExisting': aliasNode = prop.initializer; break;
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
        case 'ownership':
          ownershipSeen = true;
          ownershipText = this.staticOwnership(prop.initializer);
          break;
      }
    }

    if (!tokenNode) return null;

    // An alias is read before anything else: a property token or `ownership` would otherwise be judged as a registration.
    if (aliasNode) return this.parseAlias(obj, sourceFile, tokenNode, aliasNode, isScoped, declared);

    if (ownershipSeen && ownershipText !== 'owned' && ownershipText !== 'borrowed') {
      return {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: `NEO_CONFIG_UNSUPPORTED: ownership must be a static 'owned' or 'borrowed' literal.`,
        node: obj,
        sourceFile,
      };
    }

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

      const propertyTypeError = this.checkPropertyProviderType(
        resolvedTokenNode as ts.CallExpression,
        providerNode,
        obj,
        sourceFile
      );
      if (propertyTypeError) return propertyTypeError;
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

      // useValue is never owned: the caller keeps the object and destroys it.
      if (ownershipSeen && ownershipText !== 'borrowed') {
        return {
          type: 'unsupported',
          code: 'NEO_CONFIG_UNSUPPORTED',
          message: `NEO_CONFIG_UNSUPPORTED: useValue cannot be declared owned. Register a factory with ownership: 'owned', or omit ownership.`,
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
        valueOrigin: originOf(valueNode, sourceFile),
        tokenType: this.interfaceTokenType(resolvedTokenNode),
        useFactory: false,
        isAsync: false,
        registrationType: 'value',
        isDisposable: false,
        isAsyncDisposable: false,
        ownership: ownershipText === 'borrowed' ? 'borrowed' : undefined,
      };
    }

    // 5. Async factory detection and transient validation
    const isAsync = useFactory && providerNode ? this.isAsyncFunction(providerNode) : false;
    if (isAsync && lifecycle === 'transient') {
      return {
        type: 'type-mismatch',
        code: 'NEO_ASYNC_TRANSIENT',
        message: `Async factory for '${tokenText}' cannot use lifecycle: 'transient'. Async factories are pre-initialized once in initialize() and must be singletons. Remove lifecycle: 'transient' or make the factory synchronous.`,
        node: obj,
        sourceFile,
      };
    }

    let factoryDependencies: FactoryDependency[] | undefined;
    let opaque: boolean | undefined;
    let dependenciesWarning: AnalysisError | undefined;
    if (useFactory) {
      const contract = this.readFactoryContract(obj, providerNode, tokenText, sourceFile);
      if (!('__factory' in contract)) return contract;
      factoryDependencies = contract.factoryDependencies;
      opaque = contract.opaque;
      dependenciesWarning = contract.dependenciesWarning;
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

    // 8. Detect disposable interface. Singleton factories stay unset.
    const { isDisposable, isAsyncDisposable } = this.disposableFlagsFor(
      registrationType,
      lifecycle,
      implementationSymbol,
      providerNode,
      tokenNode,
    );

    const factorySource =
      registrationType === 'factory' && providerNode ? providerNode.getText(sourceFile) : undefined;
    const factoryOrigin =
      registrationType === 'factory' && providerNode ? originOf(providerNode, sourceFile) : undefined;

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
      factoryOrigin,
      factoryBindings: registrationType === 'factory' && providerNode ? this.copiedBindings(providerNode) : undefined,
      isAsync,
      implementationSymbol,
      registrationType,
      isDisposable,
      isAsyncDisposable,
      implementationLocalName,
      tokenLocalName,
      implementationBinding: identifierText(providerNode ?? tokenNode),
      tokenBinding: tokenSymbol ? identifierText(tokenNode) : undefined,
      tokenType: isInterfaceToken ? this.interfaceTokenType(resolvedTokenNode) : undefined,
      factoryDependencies,
      opaque,
      dependenciesWarning,
      ownership: ownershipText === 'owned' || ownershipText === 'borrowed' ? ownershipText : undefined,
    };
  }

  /**
   * `{ token, useExisting }`: the token answers what the target answers. The registration carries none of the options of
   * the other shapes (`ALIAS_FORBIDDEN`), and its token is a class or an interface token: a property token is read
   * from a factory, which an alias is not. The target is any token: the checks that it is provided, that it is not
   * multi and that its value fits are the validators', so the same registration is judged the same way everywhere.
   */
  private parseAlias(
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    tokenNode: ts.Expression,
    aliasNode: ts.Expression,
    isScoped: boolean,
    declared: ReadonlySet<string>,
  ): ParsedInjection | AnalysisError {
    const unsupported = (message: string): AnalysisError => ({
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `NEO_CONFIG_UNSUPPORTED: ${message}`,
      node: obj,
      sourceFile,
    });
    const forbidden = ALIAS_FORBIDDEN.find((name) => declared.has(name));
    if (forbidden === 'multi') {
      return unsupported("an alias cannot be multi: a multi token is read with resolveAll, and an alias answers one object. Remove 'multi'.");
    }
    if (forbidden !== undefined) {
      return unsupported(`an alias (useExisting) cannot declare '${forbidden}': it owns nothing, and its target keeps the provider, the lifecycle and the owner. Remove '${forbidden}'.`);
    }
    const resolvedTokenNode = this.tokenResolverService.resolveToInitializer(tokenNode) ?? tokenNode;
    if (this.tokenResolverService.isUsePropertyCall(resolvedTokenNode)) {
      return unsupported('an alias cannot be a property token (useProperty): a property token is provided by a factory. Register a factory for it, or alias a class or interface token.');
    }
    let tokenId: TokenId | null;
    let tokenSymbol: ts.Symbol | undefined;
    let isInterfaceToken = false;
    if (this.tokenResolverService.isUseInterfaceCall(resolvedTokenNode)) {
      tokenId = this.tokenResolverService.extractInterfaceTokenId(resolvedTokenNode);
      isInterfaceToken = true;
    } else {
      tokenId = namedToken(() => this.tokenResolverService.getTypeIdFromConstructor(this.checker.getTypeAtLocation(tokenNode)));
      if (TSContext.ts.isIdentifier(tokenNode)) tokenSymbol = this.checker.getSymbolAtLocation(tokenNode) ?? undefined;
    }
    const targetId = namedToken(() => this.tokenResolverService.resolveTokenId(aliasNode));
    if (!tokenId || !targetId) {
      return unsupported('useExisting must name a token: a class, useInterface<T>() or a variable that holds one.');
    }
    const resolvedTarget = this.tokenResolverService.resolveToInitializer(aliasNode) ?? aliasNode;
    const tokenText = tokenNode.getText(sourceFile);
    return {
      __kind: 'parsed',
      tokenNode,
      resolvedTokenNode,
      tokenId,
      tokenText,
      tokenSymbol,
      isInterfaceToken,
      isValueToken: false,
      isMulti: false,
      isScoped,
      // A filler nobody reads: the lifecycle and the owner of an alias are its target's.
      lifecycle: 'singleton',
      useFactory: false,
      isAsync: false,
      registrationType: 'alias',
      isDisposable: false,
      isAsyncDisposable: false,
      tokenLocalName: this.resolveDefaultLocalName(tokenSymbol, TSContext.ts.isIdentifier(tokenNode) ? tokenNode : undefined),
      tokenBinding: tokenSymbol ? identifierText(tokenNode) : undefined,
      tokenType: isInterfaceToken ? this.interfaceTokenType(resolvedTokenNode) : undefined,
      aliasTarget: {
        tokenId: targetId,
        ...(this.tokenResolverService.isUseInterfaceCall(resolvedTarget) ? { isInterfaceToken: true } : {}),
      },
    };
  }

  /** `'borrowed' as const` and a const binding of that literal are both static. */
  private staticOwnership(expr: ts.Expression): 'owned' | 'borrowed' | undefined {
    let current = expr;
    while (
      TSContext.ts.isParenthesizedExpression(current)
      || TSContext.ts.isAsExpression(current)
      || TSContext.ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    if (TSContext.ts.isStringLiteralLike(current)) {
      return current.text === 'owned' || current.text === 'borrowed' ? current.text : undefined;
    }
    const type = this.checker.getTypeAtLocation(current);
    if (type.isStringLiteral()) {
      return type.value === 'owned' || type.value === 'borrowed' ? type.value : undefined;
    }
    return undefined;
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

  /**
   * Class symbols use the declared type. A transient factory uses the call return
   * type, then the token type. A singleton factory is left unset.
   */
  private disposableFlagsFor(
    registrationType: ParsedRegistrationType,
    lifecycle: 'singleton' | 'transient',
    implementationSymbol: ts.Symbol | undefined,
    providerNode: ts.Expression | undefined,
    tokenNode: ts.Expression,
  ): { isDisposable: boolean; isAsyncDisposable: boolean } {
    if (registrationType === 'factory') {
      if (lifecycle !== 'transient') return { isDisposable: false, isAsyncDisposable: false };
      return this.detectTransientFactoryDisposable(providerNode, tokenNode);
    }
    if (!implementationSymbol) return { isDisposable: false, isAsyncDisposable: false };
    return this.detectDisposable(implementationSymbol);
  }

  /** `dispose` on the factory's return type, otherwise on the token's service type. */
  private detectTransientFactoryDisposable(
    providerNode: ts.Expression | undefined,
    tokenNode: ts.Expression,
  ): { isDisposable: boolean; isAsyncDisposable: boolean } {
    if (providerNode) {
      const providerType = this.checker.getTypeAtLocation(providerNode);
      const signature = providerType.getCallSignatures()[0];
      if (signature) {
        const flags = this.disposableFlags(this.checker.getReturnTypeOfSignature(signature));
        if (flags.isDisposable || flags.isAsyncDisposable) return flags;
      }
    }
    return this.disposableFlags(this.tokenServiceType(tokenNode));
  }

  /**
   * Class tokens use the instance type. Interface and property tokens use T
   * from `InterfaceToken<T>` / `PropertyToken<T>`.
   */
  private tokenServiceType(tokenNode: ts.Expression): ts.Type {
    const type = this.checker.getTypeAtLocation(tokenNode);
    const branded = this.brandedArgument(type);
    if (branded) return branded;
    const classSymbol = this.classSymbolOf(tokenNode);
    if (classSymbol) return this.declaredInstance(classSymbol);
    return type;
  }

  private declaredInstance(classSymbol: ts.Symbol): ts.Type {
    return this.checker.getDeclaredTypeOfSymbol(classSymbol);
  }

  private brandedArgument(type: ts.Type): ts.Type | undefined {
    if (type.flags & TSContext.ts.TypeFlags.Any || type.flags & TSContext.ts.TypeFlags.Unknown) return undefined;
    const brand = type.getProperty('__brand');
    const argument = type.getProperty('__type');
    if (!brand || !argument) return undefined;
    const brandType = this.checker.getTypeOfSymbol(brand);
    if (!brandType.isStringLiteral()) return undefined;
    if (brandType.value !== 'InterfaceToken' && brandType.value !== 'PropertyToken') return undefined;
    return this.checker.getTypeOfSymbol(argument);
  }

  private classSymbolOf(tokenNode: ts.Expression): ts.Symbol | undefined {
    const atNode = this.checker.getSymbolAtLocation(tokenNode);
    const symbol = atNode && (atNode.flags & TSContext.ts.SymbolFlags.Alias)
      ? this.checker.getAliasedSymbol(atNode)
      : atNode;
    if (symbol && (symbol.flags & TSContext.ts.SymbolFlags.Class)) return symbol;
    return undefined;
  }

  /** Detects whether a class symbol implements dispose(): void or dispose(): Promise<void>. */
  private detectDisposable(symbol: ts.Symbol): { isDisposable: boolean; isAsyncDisposable: boolean } {
    if (symbol.flags & TSContext.ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return this.disposableFlags(this.checker.getDeclaredTypeOfSymbol(symbol));
  }

  private disposableFlags(type: ts.Type): { isDisposable: boolean; isAsyncDisposable: boolean } {
    if (type.flags & TSContext.ts.TypeFlags.Any || type.flags & TSContext.ts.TypeFlags.Unknown) {
      return { isDisposable: false, isAsyncDisposable: false };
    }
    const disposeMember = type.getProperty('dispose');
    if (!disposeMember) return { isDisposable: false, isAsyncDisposable: false };

    const disposeType = this.checker.getTypeOfSymbol(disposeMember);
    const signatures = disposeType.getCallSignatures();
    const signature = signatures[0];
    if (!signature) return { isDisposable: false, isAsyncDisposable: false };

    const returnType = this.checker.getReturnTypeOfSignature(signature);
    const isAsync = this.checker.typeToString(returnType).startsWith('Promise');

    return { isDisposable: !isAsync, isAsyncDisposable: isAsync };
  }

  /**
   * Validates that the factory provider's return type is assignable to the T in useProperty<T>.
   * Example: useProperty<number>(...) with provider: () => 'a string' → type-mismatch error.
   */
  private checkPropertyProviderType(
    tokenCall: ts.CallExpression,
    providerNode: ts.Expression,
    registrationNode: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile
  ): AnalysisError | null {
    if (!tokenCall.typeArguments || tokenCall.typeArguments.length === 0) return null;

    let expectedType: ts.Type;
    try {
      expectedType = this.checker.getTypeFromTypeNode(tokenCall.typeArguments[0]);
    } catch {
      return null;
    }

    const providerType = this.checker.getTypeAtLocation(providerNode);
    const signatures = providerType.getCallSignatures();

    if (signatures.length === 0) {
      // Distinguish between a class constructor (has construct signatures — clearly wrong for
      // useProperty) and other non-callables like object literals (handled elsewhere or
      // intentionally unvalidated here). Only emit an error for class constructors.
      const constructSignatures = providerType.getConstructSignatures();
      if (constructSignatures.length > 0) {
        const expectedName = this.checker.typeToString(expectedType);
        return {
          type: 'type-mismatch',
          message: `Type mismatch: provider for useProperty<${expectedName}> must be a factory function () => ${expectedName}, not a class constructor.`,
          node: registrationNode,
          sourceFile,
        };
      }
      return null;
    }

    // For async factories, the signature return type is Promise<T>. Since async useProperty
    // providers are resolved via initialize() at runtime, we skip static type validation
    // for them to avoid false-positive type-mismatch errors.
    if (this.isAsyncFunction(providerNode)) return null;

    // Note: for overloaded providers only signatures[0] is checked (simplification).
    const returnType = this.checker.getReturnTypeOfSignature(signatures[0]);

    if (!this.checker.isTypeAssignableTo(returnType, expectedType)) {
      const expectedName = this.checker.typeToString(expectedType);
      const returnName = this.checker.typeToString(returnType);
      return {
        type: 'type-mismatch',
        message: `Type mismatch: provider for useProperty<${expectedName}> returns '${returnName}', but '${expectedName}' is expected.`,
        node: registrationNode,
        sourceFile,
      };
    }

    return null;
  }

  private isAsyncFunction(node: ts.Expression): boolean {
    const fn = node;
    if (
      (TSContext.ts.isArrowFunction(fn) || TSContext.ts.isFunctionExpression(fn)) &&
      fn.modifiers?.some(m => m.kind === TSContext.ts.SyntaxKind.AsyncKeyword)
    ) return true;
    return this.returnsPromiseLike(fn);
  }

  private returnsPromiseLike(fn: ts.Expression): boolean {
    const signatures = this.checker.getTypeAtLocation(fn).getCallSignatures();
    if (signatures.length === 0) return false;
    return this.isPromiseLikeType(this.checker.getReturnTypeOfSignature(signatures[0]));
  }

  private isPromiseLikeType(type: ts.Type): boolean {
    const names = [type.getSymbol()?.getName(), type.aliasSymbol?.getName()];
    return names.includes('Promise') || names.includes('PromiseLike');
  }

  private readFactoryContract(
    obj: ts.ObjectLiteralExpression,
    providerNode: ts.Expression | undefined,
    tokenText: string,
    sourceFile: ts.SourceFile,
  ): AnalysisError | FactoryContract {
    let dependenciesNode: ts.Expression | undefined;
    for (const prop of obj.properties) {
      if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;
      if (prop.name.text === 'dependencies') dependenciesNode = prop.initializer;
    }

    const dependenciesMissing = !dependenciesNode;
    if (this.validation === 'strict' && !dependenciesNode) {
      return {
        type: 'unsupported',
        code: 'NEO_FACTORY_DEPENDENCIES_REQUIRED',
        message: `NEO_FACTORY_DEPENDENCIES_REQUIRED: factory '${tokenText}' requires a dependencies list.`,
        node: obj,
        sourceFile,
      };
    }
    if (dependenciesMissing) {
      return {
        __factory: true,
        factoryDependencies: [],
        opaque: true,
        dependenciesWarning: {
          type: 'unsupported',
          code: 'NEO_FACTORY_DEPENDENCIES_REQUIRED',
          severity: 'warning',
          message: `NEO_FACTORY_DEPENDENCIES_REQUIRED: factory '${tokenText}' has no dependencies list and is opaque.`,
          node: obj,
          sourceFile,
        },
      };
    }
    if (!dependenciesNode || !TSContext.ts.isArrayLiteralExpression(dependenciesNode)) {
      return {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: `NEO_CONFIG_UNSUPPORTED: factory '${tokenText}' dependencies must be an array.`,
        node: obj,
        sourceFile,
      };
    }

    const parsed = this.parseFactoryDependencies(dependenciesNode, obj, tokenText, sourceFile);
    if (!('__deps' in parsed)) return parsed;
    if (this.validation === 'strict' && providerNode) {
      const escape = this.findCapturedContainerResolve(providerNode, tokenText, obj, sourceFile);
      if (escape) return escape;
    }
    return { __factory: true, factoryDependencies: parsed.deps };
  }

  private parseFactoryDependencies(
    array: ts.ArrayLiteralExpression,
    obj: ts.ObjectLiteralExpression,
    tokenText: string,
    sourceFile: ts.SourceFile,
  ): AnalysisError | { __deps: true; deps: FactoryDependency[] } {
    const containerId = this.enclosingContainerId(obj);
    const deps: FactoryDependency[] = [];
    for (const element of array.elements) {
      if (TSContext.ts.isSpreadElement(element)) {
        return this.unsupportedDependencies(tokenText, obj, sourceFile);
      }
      if (TSContext.ts.isObjectLiteralExpression(element)) {
        const tokenExpr = this.allTokenExpression(element);
        if (!tokenExpr) return this.unsupportedDependencies(tokenText, obj, sourceFile);
        const tokenId = this.tokenResolverService.resolveTokenId(tokenExpr);
        if (!tokenId) return this.unsupportedDependencies(tokenText, obj, sourceFile);
        deps.push({ tokenId, all: true, source: tokenExpr.getText(sourceFile), containerId });
        continue;
      }
      const tokenId = this.tokenResolverService.resolveTokenId(element);
      if (!tokenId) return this.unsupportedDependencies(tokenText, obj, sourceFile);
      deps.push({ tokenId, all: false, source: element.getText(sourceFile), containerId });
    }
    return { __deps: true, deps };
  }

  private allTokenExpression(element: ts.ObjectLiteralExpression): ts.Expression | undefined {
    for (const prop of element.properties) {
      if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;
      if (prop.name.text === 'all') return prop.initializer;
    }
    return undefined;
  }

  private unsupportedDependencies(
    tokenText: string,
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
  ): AnalysisError {
    return {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `NEO_CONFIG_UNSUPPORTED: factory '${tokenText}' has a dependencies entry that is not a token or { all: token }.`,
      node: obj,
      sourceFile,
    };
  }

  private enclosingContainerId(node: ts.Node): string {
    let current: ts.Node | undefined = node;
    while (current) {
      if (TSContext.ts.isCallExpression(current) && this.isConfigCallee(current)) {
        return containerKeyFor(current);
      }
      current = current.parent;
    }
    return containerKeyFor(node);
  }

  private isConfigCallee(call: ts.CallExpression): boolean {
    const marker = resolveNeoMarker(this.checker, call);
    if (marker === 'defineBuilderConfig' || marker === 'definePartialConfig') return true;
    const expr = call.expression;
    if (TSContext.ts.isIdentifier(expr)) {
      if (expr.text === 'defineBuilderConfig' || expr.text === 'definePartialConfig') return true;
      const name = this.checker.getSymbolAtLocation(expr)?.getName();
      return name === 'defineBuilderConfig' || name === 'definePartialConfig';
    }
    if (TSContext.ts.isPropertyAccessExpression(expr)) {
      return expr.name.text === 'defineBuilderConfig' || expr.name.text === 'definePartialConfig';
    }
    return false;
  }

  private findCapturedContainerResolve(
    providerNode: ts.Expression,
    tokenText: string,
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
  ): AnalysisError | undefined {
    if (!TSContext.ts.isArrowFunction(providerNode) && !TSContext.ts.isFunctionExpression(providerNode)) {
      return undefined;
    }
    const paramSymbol = this.factoryParameterSymbol(providerNode);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (TSContext.ts.isCallExpression(node) && TSContext.ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if ((name === 'resolve' || name === 'resolveAll' || name === 'resolveMany') && this.isOtherContainerReceiver(node.expression.expression, paramSymbol)) {
          found = true;
          return;
        }
      }
      TSContext.ts.forEachChild(node, visit);
    };
    visit(providerNode.body);
    if (!found) return undefined;
    return {
      type: 'unsupported',
      code: 'NEO_UNDECLARED_FACTORY_DEP',
      message: `NEO_UNDECLARED_FACTORY_DEP: factory '${tokenText}' resolves a captured container instead of its context.`,
      node: obj,
      sourceFile,
    };
  }

  private factoryParameterSymbol(provider: ts.ArrowFunction | ts.FunctionExpression): ts.Symbol | undefined {
    const param = provider.parameters[0];
    if (!param || !TSContext.ts.isIdentifier(param.name)) return undefined;
    return this.checker.getSymbolAtLocation(param.name);
  }

  private isOtherContainerReceiver(receiver: ts.Expression, paramSymbol: ts.Symbol | undefined): boolean {
    if (!TSContext.ts.isIdentifier(receiver)) return false;
    const symbol = this.checker.getSymbolAtLocation(receiver);
    if (paramSymbol && symbol === paramSymbol) return false;
    return this.initializerIsConfigCall(receiver, 0);
  }

  private initializerIsConfigCall(expr: ts.Expression, depth: number): boolean {
    if (depth > 20) return false;
    let current = expr;
    while (
      TSContext.ts.isParenthesizedExpression(current) ||
      TSContext.ts.isAsExpression(current) ||
      TSContext.ts.isTypeAssertionExpression(current) ||
      (TSContext.ts.isSatisfiesExpression && TSContext.ts.isSatisfiesExpression(current))
    ) {
      current = current.expression;
    }
    if (TSContext.ts.isCallExpression(current)) return this.isConfigCallee(current);
    if (!TSContext.ts.isIdentifier(current)) return false;
    const symbol = this.checker.getSymbolAtLocation(current);
    const decl = symbol?.getDeclarations()?.[0];
    if (!decl || !TSContext.ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    return this.initializerIsConfigCall(decl.initializer, depth + 1);
  }

  /**
   * Returns the local identifier name for a symbol if it is an alias for a 'default' export.
   * After ConfigParser/ConfigCollector call resolveSymbol(), the alias chain is followed and the
   * local binding name (e.g. "Auth" from `import Auth from './Foo'`) is replaced by "default".
   * This method captures the local name while the original AST node is still available.
   */
  /**
   * The names `expression` reads that its own file binds and that it does not declare itself, with the module
   * that exports each one. A module-less name (a global, a lib type), a package or declaration file (no
   * specifier can be written from here), and a top-level declaration the file keeps to itself are left out:
   * nothing in another file could import them.
   */
  private copiedBindings(expression: ts.Expression): CopiedBinding[] | undefined {
    const api = TSContext.ts;
    const sourceFile = expression.getSourceFile();
    const start = expression.getStart(sourceFile);
    const end = expression.getEnd();
    const found = new Map<string, {
      file: string;
      exportName?: string;
      localName?: string;
      ranges: Array<{ start: number; end: number; shorthand?: string; type?: true }>;
    }>();
    /** A read in a position TypeScript erases: a type reference, a `typeof` query, an `implements` or interface `extends` clause. */
    const inTypePosition = (node: ts.Identifier): boolean => {
      let current: ts.Node = node;
      while (api.isQualifiedName(current.parent) && current.parent.left === current) current = current.parent;
      const parent = current.parent;
      if (api.isTypeReferenceNode(parent)) return parent.typeName === current;
      if (api.isTypeQueryNode(parent)) return parent.exprName === current;
      if (api.isExpressionWithTypeArguments(parent)) {
        const clause = parent.parent;
        return api.isHeritageClause(clause)
          && (clause.token === api.SyntaxKind.ImplementsKeyword || api.isInterfaceDeclaration(clause.parent));
      }
      return false;
    };
    const isNameOnly = (node: ts.Identifier): boolean => {
      const parent = node.parent;
      if (api.isPropertyAccessExpression(parent)) return parent.name === node;
      if (api.isQualifiedName(parent)) return parent.right === node;
      if (api.isBindingElement(parent)) return parent.propertyName === node;
      if (api.isPropertyAssignment(parent) || api.isMethodDeclaration(parent) || api.isPropertyDeclaration(parent)
        || api.isPropertySignature(parent) || api.isMethodSignature(parent) || api.isGetAccessorDeclaration(parent)
        || api.isSetAccessorDeclaration(parent) || api.isEnumMember(parent) || api.isNamedTupleMember(parent)) {
        return parent.name === node;
      }
      return api.isLabeledStatement(parent) || api.isBreakOrContinueStatement(parent) || api.isJsxAttribute(parent);
    };
    const topLevel = (declaration: ts.Declaration): boolean => {
      const parent = declaration.parent;
      if (parent === declaration.getSourceFile()) return true;
      return api.isVariableDeclaration(declaration)
        && api.isVariableDeclarationList(parent)
        && parent.parent.parent === declaration.getSourceFile();
    };
    const exportNameOf = (file: ts.SourceFile, target: ts.Symbol): string | undefined => {
      const moduleSymbol = this.checker.getSymbolAtLocation(file);
      if (!moduleSymbol) return undefined;
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const resolved = (exported.flags & api.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(exported) : exported;
        if (resolved === target) return exported.getName();
      }
      return undefined;
    };
    const visit = (node: ts.Node): void => {
      if (api.isIdentifier(node) && !isNameOnly(node)) {
        const shorthand = api.isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
        const symbol = shorthand
          ? this.checker.getShorthandAssignmentValueSymbol(node.parent)
          : this.checker.getSymbolAtLocation(node);
        const declaredInside = symbol?.declarations?.some((declaration) =>
          declaration.getSourceFile() === sourceFile && declaration.getStart(sourceFile) >= start && declaration.getEnd() <= end);
        if (symbol && !declaredInside) {
          const alias = (symbol.flags & api.SymbolFlags.Alias) !== 0;
          const target = alias ? this.checker.getAliasedSymbol(symbol) : symbol;
          const declaration = target.declarations?.[0];
          const declaringFile = declaration && api.isSourceFile(declaration) ? declaration : declaration?.getSourceFile();
          const usable = declaration !== undefined && declaringFile !== undefined
            && !declaringFile.isDeclarationFile
            && !declaringFile.fileName.includes('/node_modules/')
            && api.isExternalModule(declaringFile);
          if (usable && declaration && declaringFile) {
            const wholeModule = api.isSourceFile(declaration);
            const exportName = wholeModule ? undefined : (topLevel(declaration) ? exportNameOf(declaringFile, target) : undefined);
            if (wholeModule || exportName !== undefined) {
              const key = `${declaringFile.fileName}\0${exportName ?? ''}`;
              const declared = wholeModule ? undefined : api.getNameOfDeclaration(declaration);
              const localName = declared !== undefined && api.isIdentifier(declared) ? declared.text : undefined;
              const entry = found.get(key) ?? { file: declaringFile.fileName, exportName, ...(localName === undefined ? {} : { localName }), ranges: [] };
              const range: { start: number; end: number; shorthand?: string; type?: true } = {
                start: node.getStart(sourceFile),
                end: node.getEnd(),
              };
              if (shorthand) range.shorthand = node.text;
              if (inTypePosition(node)) range.type = true;
              entry.ranges.push(range);
              found.set(key, entry);
            }
          }
        }
      }
      api.forEachChild(node, visit);
    };
    visit(expression);
    return found.size === 0 ? undefined : [...found.values()];
  }

  /**
   * The type behind `useInterface<T>()`, when a generated file can name it: a type argument that is a plain
   * reference to an interface, type alias, class or enum, with no type argument of its own, declared at the
   * top level of a file. A file-less, generic, anonymous or nested type has no reference: the generator then
   * keeps `unknown` for that provider and narrows where the value is read.
   */
  private interfaceTokenType(tokenNode: ts.Expression): TypeReference | undefined {
    const ts = TSContext.ts;
    if (!ts.isCallExpression(tokenNode)) return undefined;
    const typeNode = tokenNode.typeArguments?.[0];
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return undefined;
    if ((typeNode.typeArguments?.length ?? 0) > 0 || !ts.isIdentifier(typeNode.typeName)) return undefined;
    let symbol = this.checker.getSymbolAtLocation(typeNode.typeName);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = this.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.declarations?.[0];
    if (!symbol || !declaration) return undefined;
    const named = ts.isInterfaceDeclaration(declaration)
      || ts.isTypeAliasDeclaration(declaration)
      || ts.isClassDeclaration(declaration)
      || ts.isEnumDeclaration(declaration);
    if (!named || declaration.parent !== declaration.getSourceFile()) return undefined;
    if (!ts.isEnumDeclaration(declaration) && (declaration.typeParameters?.length ?? 0) > 0) return undefined;
    const file = declaration.getSourceFile();
    const name = symbol.getName();
    if (!ts.isExternalModule(file)) return { name, file: file.fileName, global: true };
    const moduleSymbol = this.checker.getSymbolAtLocation(file);
    if (!moduleSymbol) return { name, file: file.fileName };
    for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
      const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(exported) : exported;
      if (target === symbol) return { name, file: file.fileName, exportName: exported.getName() };
    }
    return { name, file: file.fileName };
  }

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
