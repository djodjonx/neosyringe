import type * as ts from 'typescript';
import { basename } from 'node:path';
import { TSContext } from '../../TSContext';
import type { AnalysisError, DependencyGraph, DependencyNode, RetentionReason, ServiceDefinition, TokenId, ValidationMode } from '../types';
import { getSimpleName } from '../utils/TokenUtils';
import { resolveNeoMarker } from '../shared/markerProvenance';
import { extendsCaptureText } from '../shared/extendsReference';
import { containerKeyFor, declaredFactoryEdges, partialInjectionsSpreadError, stampRegistration, valueCaptureFor as captureExpression } from '../shared/registrationGraph';
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
    private tokenResolverService: TokenResolverService,
    private validation: ValidationMode = 'strict',
  ) {
    this.injectionParser = new InjectionParser(checker, tokenResolverService, validation);
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
    parentContainerNames: Set<string>,
    merge = false,
    partialBinding?: string,
  ): void {
    const args = node.arguments;
    if (args.length < 1) return;

    const configObj = args[0];
    if (!TSContext.ts.isObjectLiteralExpression(configObj)) return;

    // A merged partial keeps the host container's name, id and key.
    if (!merge) {
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
      graph.containerKey = containerKeyFor(node);
    }

    // Parse 'extends' before local injections so partial multi order is stable.
    const extendsProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'extends'
    );

    if (extendsProp && TSContext.ts.isPropertyAssignment(extendsProp) && TSContext.ts.isArrayLiteralExpression(extendsProp.initializer)) {
      this.parseExtendsArray(extendsProp.initializer, graph, parentContainerNames);
    }

    // Parse 'injections' property
    const injectionsProp = configObj.properties.find(p =>
      p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'injections'
    );

    if (injectionsProp && TSContext.ts.isPropertyAssignment(injectionsProp) && TSContext.ts.isArrayLiteralExpression(injectionsProp.initializer)) {
      this.parseInjectionsArray(injectionsProp.initializer, graph, partialBinding, merge);
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

    // A merged partial keeps the host optimization. ADR006 lines 9-14.
    if (!merge) {
      const known = new Set<TokenId>(graph.nodes.keys());
      if (graph.multiNodes) {
        for (const id of graph.multiNodes.keys()) known.add(id);
      }
      readOptimization(configObj, graph, known, (expr) => this.tokenResolverService.resolveTokenId(expr));
      readRuntimeProfile(configObj, graph);
      const diagnostics = closedModeDiagnostics(
        graph.optimizationMode,
        this.validation,
        opaqueFactoryNames(graph),
        configObj,
        configObj.getSourceFile(),
      );
      if (diagnostics.length > 0) {
        if (!graph.errors) graph.errors = [];
        graph.errors.push(...diagnostics);
      }
    }
  }

  /**
   * Parses an array of injection objects.
   *
   * @param arrayLiteral - The injections array literal
   * @param graph - The dependency graph to populate
   */
  private parseInjectionsArray(
    arrayLiteral: ts.ArrayLiteralExpression,
    graph: DependencyGraph,
    partialBinding?: string,
    merge = false,
  ): void {
    if (partialBinding) {
      const spread = partialInjectionsSpreadError(arrayLiteral.elements);
      if (spread) {
        if (!graph.errors) graph.errors = [];
        graph.errors.push({
          type: 'unsupported',
          code: spread.code,
          message: spread.message,
          node: spread.node,
          sourceFile: arrayLiteral.getSourceFile(),
        });
        return;
      }
    }
    for (let index = 0; index < arrayLiteral.elements.length; index++) {
      const element = arrayLiteral.elements[index];
      if (TSContext.ts.isObjectLiteralExpression(element)) {
        this.parseInjectionObject(element, graph, partialBinding, index, merge);
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
  parseInjectionObject(
    obj: ts.ObjectLiteralExpression,
    graph: DependencyGraph,
    partialBinding?: string,
    index = 0,
    merge = false,
  ): void {
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
        valueCapture: this.valueCaptureFor(graph, partialBinding, index, merge),
        ownership: parsed.ownership,
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
        factoryDependencies: parsed.factoryDependencies,
        opaque: parsed.opaque,
        ownership: parsed.ownership,
      };
      if (parsed.dependenciesWarning) {
        if (!graph.errors) graph.errors = [];
        graph.errors.push(parsed.dependenciesWarning);
      }
      this.addToGraph(isMulti, tokenId, { service: definition, dependencies: declaredFactoryEdges(definition) }, graph);
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

  /** Direct useValue is hoisted once. A partial reads the property; it does not re-run the expression. */
  private valueCaptureFor(
    graph: DependencyGraph,
    partialBinding: string | undefined,
    index: number,
    merge: boolean,
  ): string | undefined {
    if (!partialBinding && merge) return undefined;
    return captureExpression(graph.containerKey, index, partialBinding);
  }

  private addToGraph(
    isMulti: boolean,
    tokenId: TokenId,
    node: DependencyNode,
    graph: DependencyGraph
  ): void {
    stampRegistration(node.service, node.service.registrationNode, graph.containerKey);
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
      if (TSContext.ts.isIdentifier(element) || TSContext.ts.isPropertyAccessExpression(element)) {
        this.parsePartialConfig(element, graph, parentContainerNames);
      }
    }
  }

  /**
   * Parses a partial config referenced by identifier or by a namespace property (`P.part`).
   * The property name is resolved with the checker, the same way a plain identifier is.
   *
   * @param element - The extends element
   * @param graph - The dependency graph to populate
   * @param parentContainerNames - Set of parent container names
   */
  private parsePartialConfig(
    element: ts.Identifier | ts.PropertyAccessExpression,
    graph: DependencyGraph,
    parentContainerNames: Set<string>
  ): void {
    const located = TSContext.ts.isPropertyAccessExpression(element) ? element.name : element;
    const symbol = this.checker.getSymbolAtLocation(located);
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
        // The binding is the expression written in `extends`, not the declaration name.
        const partialBinding = extendsCaptureText(element);
        this.parseBuilderConfig(callExpr, graph, parentContainerNames, true, partialBinding);
      }
    }
  }

  /**
   * Checks if a call expression is definePartialConfig.
   */
  private isDefinePartialConfigCall(node: ts.CallExpression): boolean {
    return resolveNeoMarker(this.checker, node) === 'definePartialConfig';
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

const RETENTION_RANK: Record<RetentionReason['kind'], number> = {
  root: 5,
  eager: 4,
  'multi-contribution-of': 3,
  'dependency-of': 2,
  'parent-boundary': 1,
  unreachable: 0,
};

export interface OptimizationTarget {
  optimizationMode?: 'open' | 'closed';
  publicRoots?: TokenId[];
  publicMultiRoots?: TokenId[];
  eagerRoots?: TokenId[];
  runtimeProfile?: 'full' | 'minimal';
  errors?: AnalysisError[];
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    TSContext.ts.isAsExpression(current)
    || TSContext.ts.isParenthesizedExpression(current)
    || TSContext.ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function namedInitializer(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (!prop.name || !TSContext.ts.isIdentifier(prop.name) || prop.name.text !== name) continue;
    if (TSContext.ts.isPropertyAssignment(prop)) return prop.initializer;
    if (TSContext.ts.isShorthandPropertyAssignment(prop)) return prop.name;
  }
  return undefined;
}

function pushConfigError(target: OptimizationTarget, error: AnalysisError): void {
  if (!target.errors) target.errors = [];
  target.errors.push(error);
}

/**
 * Literal optimization only. A resolve() call in the file is not a root.
 * ADR006 lines 9-14. 04-api-et-diagnostics.md line 202.
 */
export function readOptimization(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
  known: ReadonlySet<TokenId>,
  resolve: (expr: ts.Expression) => TokenId | null,
): void {
  const optimization = namedInitializer(configObj, 'optimization');
  if (!optimization) return;
  const sourceFile = configObj.getSourceFile();
  const body = unwrapExpression(optimization);
  if (!TSContext.ts.isObjectLiteralExpression(body)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.",
      node: optimization,
      sourceFile,
    });
    return;
  }
  const modeNode = namedInitializer(body, 'mode');
  const modeExpr = modeNode ? unwrapExpression(modeNode) : undefined;
  if (modeNode && !(modeExpr && TSContext.ts.isStringLiteral(modeExpr))) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization mode must be the string literal 'open' or 'closed'.",
      node: modeNode,
      sourceFile,
    });
    return;
  }
  const modeText = modeExpr && TSContext.ts.isStringLiteral(modeExpr) ? modeExpr.text : undefined;
  if (modeText !== undefined && modeText !== 'open' && modeText !== 'closed') {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `NEO_CONFIG_UNSUPPORTED: optimization mode '${modeText}' is not supported.`,
      node: modeNode ?? body,
      sourceFile,
    });
    return;
  }
  const mode = modeText === 'closed' ? 'closed' : 'open';
  const rootsNode = namedInitializer(body, 'roots');
  const eagerNode = namedInitializer(body, 'eager');
  if (mode === 'open' && (rootsNode || eagerNode)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: "NEO_CONFIG_UNSUPPORTED: optimization mode 'open' cannot declare roots or eager.",
      node: rootsNode ?? eagerNode ?? body,
      sourceFile,
    });
    return;
  }
  if (mode === 'open') {
    target.optimizationMode = 'open';
    return;
  }
  const roots = readRootList(rootsNode, known, resolve, sourceFile, target);
  const eager = readRootList(eagerNode, known, resolve, sourceFile, target);
  if (!roots) return;
  target.optimizationMode = 'closed';
  target.publicRoots = roots.filter((item) => !item.all).map((item) => item.id);
  target.publicMultiRoots = roots.filter((item) => item.all).map((item) => item.id);
  target.eagerRoots = (eager ?? []).map((item) => item.id);
}

/** `name` and `'name'` are the same property. Anything else is not a literal name. */
function literalPropertyName(name: ts.PropertyName): string | undefined {
  if (TSContext.ts.isIdentifier(name) || TSContext.ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * Initializer of `name` in an object literal. A spread or computed member could hide the
 * property, so it is reported as `opaque` instead of being skipped.
 */
function literalMember(
  obj: ts.ObjectLiteralExpression,
  name: string,
): { initializer?: ts.Expression; opaque?: ts.Node } {
  let initializer: ts.Expression | undefined;
  for (const prop of obj.properties) {
    if (TSContext.ts.isSpreadAssignment(prop)) return { opaque: prop };
    if (!prop.name) continue;
    if (TSContext.ts.isComputedPropertyName(prop.name)) return { opaque: prop };
    if (literalPropertyName(prop.name) !== name) continue;
    if (TSContext.ts.isPropertyAssignment(prop)) initializer = prop.initializer;
    else if (TSContext.ts.isShorthandPropertyAssignment(prop)) initializer = prop.name;
    else return { opaque: prop };
  }
  return { initializer };
}

/**
 * Literal `runtime.profile` only. Absent or `undefined` (for `runtime` or `profile`) is the
 * full profile. 04-api-et-diagnostics.md "BuilderConfig et profils".
 */
export function readRuntimeProfile(
  configObj: ts.ObjectLiteralExpression,
  target: OptimizationTarget,
): void {
  const runtime = literalMember(configObj, 'runtime').initializer;
  if (!runtime) return;
  const sourceFile = configObj.getSourceFile();
  const body = unwrapExpression(runtime);
  const unsupported = (node: ts.Node, message: string): void => {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message,
      node,
      sourceFile,
    });
  };
  const profileMessage = "NEO_CONFIG_UNSUPPORTED: runtime.profile must be the string literal 'full' or 'minimal'.";
  if (TSContext.ts.isIdentifier(body) && body.text === 'undefined') return;
  if (!TSContext.ts.isObjectLiteralExpression(body)) {
    unsupported(runtime, profileMessage);
    return;
  }
  const member = literalMember(body, 'profile');
  if (member.opaque) {
    unsupported(member.opaque, 'NEO_CONFIG_UNSUPPORTED: runtime must be an object literal without spread or computed members.');
    return;
  }
  const profileNode = member.initializer;
  if (!profileNode) return;
  const profile = unwrapExpression(profileNode);
  if (TSContext.ts.isIdentifier(profile) && profile.text === 'undefined') return;
  if (!TSContext.ts.isStringLiteral(profile) || (profile.text !== 'full' && profile.text !== 'minimal')) {
    unsupported(profileNode, profileMessage);
    return;
  }
  target.runtimeProfile = profile.text;
}

function readRootList(
  node: ts.Expression | undefined,
  known: ReadonlySet<TokenId>,
  resolve: (expr: ts.Expression) => TokenId | null,
  sourceFile: ts.SourceFile,
  target: OptimizationTarget,
): Array<{ id: TokenId; all: boolean }> | undefined {
  if (!node) return undefined;
  const list = unwrapExpression(node);
  if (!TSContext.ts.isArrayLiteralExpression(list)) {
    pushConfigError(target, {
      type: 'unsupported',
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
      node,
      sourceFile,
    });
    return undefined;
  }
  const refs: Array<{ id: TokenId; all: boolean }> = [];
  for (const element of list.elements) {
    if (TSContext.ts.isSpreadElement(element)) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
        node: element,
        sourceFile,
      });
      return undefined;
    }
    const ref = readOneRoot(element, resolve);
    if (!ref) {
      pushConfigError(target, {
        type: 'unsupported',
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: 'NEO_CONFIG_UNSUPPORTED: optimization roots must be a literal array of tokens or { all: token }.',
        node: element,
        sourceFile,
      });
      return undefined;
    }
    if (!known.has(ref.id)) {
      pushConfigError(target, {
        type: 'missing',
        code: 'NEO_MISSING_PROVIDER',
        message: `NEO_MISSING_PROVIDER: root '${getSimpleName(ref.id)}' is not registered.`,
        node: element,
        sourceFile,
      });
      continue;
    }
    refs.push(ref);
  }
  return refs;
}

function readOneRoot(
  element: ts.Expression,
  resolve: (expr: ts.Expression) => TokenId | null,
): { id: TokenId; all: boolean } | undefined {
  const expr = unwrapExpression(element);
  if (TSContext.ts.isObjectLiteralExpression(expr)) {
    const allNode = namedInitializer(expr, 'all');
    if (!allNode || expr.properties.length !== 1) return undefined;
    const id = resolve(unwrapExpression(allNode));
    return id ? { id, all: true } : undefined;
  }
  const id = resolve(expr);
  return id ? { id, all: false } : undefined;
}

function opaqueFactoryNames(graph: DependencyGraph): string[] {
  const names: string[] = [];
  const visit = (node: DependencyNode) => {
    if (node.service.opaque === true) names.push(getSimpleName(node.service.tokenId));
  };
  for (const node of graph.nodes.values()) visit(node);
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) nodes.forEach(visit);
  }
  return names;
}

/** Closed rejects compatible mode and opaque factories. ADR002 line 29. ADR006 line 57. */
export function closedModeDiagnostics(
  mode: 'open' | 'closed' | undefined,
  validation: ValidationMode,
  opaqueNames: readonly string[],
  node: ts.Node,
  sourceFile: ts.SourceFile,
): AnalysisError[] {
  if (mode !== 'closed') return [];
  const errors: AnalysisError[] = [];
  if (validation === 'compatible') {
    errors.push({
      type: 'unsupported',
      code: 'NEO_CLOSED_REQUIRES_STRICT',
      severity: 'error',
      message: "NEO_CLOSED_REQUIRES_STRICT: closed mode requires validation: 'strict'.",
      node,
      sourceFile,
    });
  }
  for (const name of opaqueNames) {
    errors.push({
      type: 'unsupported',
      code: 'NEO_FACTORY_DEPENDENCIES_REQUIRED',
      severity: 'error',
      message: `NEO_FACTORY_DEPENDENCIES_REQUIRED: factory '${name}' is opaque; closed mode requires a dependencies list.`,
      node,
      sourceFile,
    });
  }
  return errors;
}

function registrationKey(node: DependencyNode, tokenId: TokenId): string {
  return node.service.registrationId ?? tokenId;
}

function remember(reasons: Map<string, RetentionReason>, key: string, next: RetentionReason): void {
  const current = reasons.get(key);
  if (!current || RETENTION_RANK[next.kind] > RETENTION_RANK[current.kind]) reasons.set(key, next);
}

function markBoundary(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  for (const [tokenId, node] of graph.nodes) remember(reasons, registrationKey(node, tokenId), { kind: 'parent-boundary' });
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    for (const node of nodes) remember(reasons, registrationKey(node, tokenId), { kind: 'parent-boundary' });
  }
}

function retainClosed(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  seedClosed(graph, reasons);
}

function seedClosed(graph: DependencyGraph, reasons: Map<string, RetentionReason>): void {
  for (const id of graph.publicRoots ?? []) markRoot(graph, reasons, id);
  for (const id of graph.publicMultiRoots ?? []) {
    const nodes = graph.multiNodes?.get(id) ?? [];
    for (const node of nodes) remember(reasons, registrationKey(node, id), { kind: 'root' });
  }
  for (const id of graph.eagerRoots ?? []) markEager(graph, reasons, id);
  const pending: Array<{ tokenId: TokenId; node: DependencyNode }> = [];
  for (const [tokenId, node] of graph.nodes) {
    const reason = reasons.get(registrationKey(node, tokenId));
    if (reason && reason.kind !== 'unreachable') pending.push({ tokenId, node });
  }
  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      for (const node of nodes) {
        const reason = reasons.get(registrationKey(node, tokenId));
        if (reason && reason.kind !== 'unreachable') pending.push({ tokenId, node });
      }
    }
  }
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    const mark = registrationKey(current.node, current.tokenId);
    if (seen.has(mark)) continue;
    seen.add(mark);
    followOne(graph, reasons, pending, current.node);
  }
  for (const [tokenId, node] of graph.nodes) {
    const key = registrationKey(node, tokenId);
    if (!reasons.has(key)) remember(reasons, key, { kind: 'unreachable' });
  }
  if (!graph.multiNodes) return;
  for (const [tokenId, nodes] of graph.multiNodes) {
    for (const node of nodes) {
      const key = registrationKey(node, tokenId);
      if (!reasons.has(key)) remember(reasons, key, { kind: 'unreachable' });
    }
  }
}

function markRoot(graph: DependencyGraph, reasons: Map<string, RetentionReason>, id: TokenId): void {
  const node = graph.nodes.get(id);
  if (node) remember(reasons, registrationKey(node, id), { kind: 'root' });
}

function markEager(graph: DependencyGraph, reasons: Map<string, RetentionReason>, id: TokenId): void {
  const node = graph.nodes.get(id);
  if (node) remember(reasons, registrationKey(node, id), { kind: 'eager' });
  const nodes = graph.multiNodes?.get(id);
  if (!nodes) return;
  for (const item of nodes) remember(reasons, registrationKey(item, id), { kind: 'eager' });
}

function followOne(
  graph: DependencyGraph,
  reasons: Map<string, RetentionReason>,
  pending: Array<{ tokenId: TokenId; node: DependencyNode }>,
  node: DependencyNode,
): void {
  const requester = node.service.tokenId;
  const seenDeps = new Set<TokenId>();
  for (const dep of node.service.factoryDependencies ?? []) {
    seenDeps.add(dep.tokenId);
    retainDependency(graph, reasons, pending, requester, dep.tokenId, dep.all);
  }
  for (const depId of node.dependencies) {
    if (seenDeps.has(depId)) continue;
    retainDependency(graph, reasons, pending, requester, depId, false);
  }
}

function retainDependency(
  graph: DependencyGraph,
  reasons: Map<string, RetentionReason>,
  pending: Array<{ tokenId: TokenId; node: DependencyNode }>,
  requester: TokenId,
  depId: TokenId,
  all: boolean,
): void {
  const multi = graph.multiNodes?.get(depId);
  if (all || multi) {
    for (const contribution of multi ?? []) {
      const key = registrationKey(contribution, depId);
      const before = reasons.get(key)?.kind;
      remember(reasons, key, { kind: 'multi-contribution-of', token: requester });
      if (reasons.get(key)?.kind !== before) pending.push({ tokenId: depId, node: contribution });
      else if (!before) pending.push({ tokenId: depId, node: contribution });
    }
  }
  const simple = graph.nodes.get(depId);
  if (!simple || all) return;
  const key = registrationKey(simple, depId);
  const before = reasons.get(key)?.kind;
  remember(reasons, key, { kind: 'dependency-of', token: requester });
  if (!before || reasons.get(key)?.kind !== before) pending.push({ tokenId: depId, node: simple });
}

/** One reason per registration. Open is a conservative boundary. ADR006 lines 16-24 and 47-50. */
export function assignRetention(graph: DependencyGraph): void {
  const reasons = new Map<string, RetentionReason>();
  if (graph.optimizationMode !== 'closed') {
    // Absent mode is sealed back to a boundary. Explicit open is already one.
    markBoundary(graph, reasons);
  } else {
    retainClosed(graph, reasons);
  }
  graph.retention = reasons;
}

/**
 * The boundary reason is written by {@link assignRetention}. Nothing is rewritten here.
 * ADR006 line 49.
 */
export function sealOpenParent(graph: DependencyGraph): void {
  if (graph.optimizationMode === 'closed' || graph.optimizationMode === 'open') return;
}

/** Tokens a closed container exports. Eager ids are not included. ADR006 lines 29-31. */
export function exportedRootIds(graph: DependencyGraph): { single: TokenId[]; multi: TokenId[] } {
  const single = graph.publicRoots ?? [];
  const multi = graph.publicMultiRoots ?? [];
  return { single: [...single], multi: [...multi] };
}
