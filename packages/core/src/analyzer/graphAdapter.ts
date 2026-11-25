import type * as ts from 'typescript';
import { basename } from 'node:path';
import { TSContext } from '../TSContext';
import type {
  AnalysisError,
  ConfigCollection,
  ConfigGraph,
  DependencyGraph,
  DependencyNode,
  InjectionInfo,
  RejectedBuilder,
  ServiceDefinition,
  TokenId,
  ValidationMode,
} from './types';
import { DependencyResolver } from './resolvers/DependencyResolver';
import { ParentContainerResolver } from './resolvers/ParentContainerResolver';
import {
  assignRetention,
  closedModeDiagnostics,
  opaqueFactoryNames,
  sealOpenParent,
} from './parsers/ConfigParser';
import { DisposableTransientCaptureValidator, rememberCaptureSites } from './validators';
import { HashUtils } from './shared/HashUtils';
import type { TokenResolverService } from './shared/TokenResolverService';
import { declaredFactoryEdges, stampRegistration, valueCaptureFor } from './shared/registrationGraph';
import { UNSUPPORTED_SHAPE_MESSAGE, UnsupportedContainerShapeError } from './errors/registrationErrors';

/** What the adapter needs from the analyzer: the checker, the shared token service and the validation mode. */
export interface AdapterEnv {
  checker: ts.TypeChecker;
  tokens: TokenResolverService;
  validation: ValidationMode;
}

function isRejected(entry: ConfigGraph | RejectedBuilder): entry is RejectedBuilder {
  return 'reason' in entry;
}

function emptyGraph(): DependencyGraph {
  return { containerId: 'DefaultContainer', nodes: new Map(), roots: [], errors: [] };
}

function shapeError(node: ts.CallExpression): UnsupportedContainerShapeError {
  return new UnsupportedContainerShapeError(UNSUPPORTED_SHAPE_MESSAGE, node, node.getSourceFile());
}

/**
 * Reads the VariableStatement wrapping a defineBuilderConfig call and
 * populates the graph's position fields and export modifier.
 * Returns false if the positions could not be determined.
 */
export function positionsOfCall(node: ts.CallExpression, graph: DependencyGraph): boolean {
  const parent = node.parent;

  // Case 1: const varName = defineBuilderConfig(...)
  if (TSContext.ts.isVariableDeclaration(parent) && TSContext.ts.isIdentifier(parent.name)) {
    graph.exportedVariableName = parent.name.text;

    let current: ts.Node = parent;
    while (current && !TSContext.ts.isVariableStatement(current)) {
      current = current.parent;
    }
    if (!current || !TSContext.ts.isVariableStatement(current)) return false;

    graph.variableStatementStart = current.getStart();

    const modifiers = TSContext.ts.canHaveModifiers(current)
      ? TSContext.ts.getModifiers(current)
      : undefined;

    if (modifiers) {
      const hasExport = modifiers.some(m => m.kind === TSContext.ts.SyntaxKind.ExportKeyword);
      const hasDefault = modifiers.some(m => m.kind === TSContext.ts.SyntaxKind.DefaultKeyword);
      graph.variableExportModifier = hasExport && hasDefault ? 'export default' : hasExport ? 'export' : 'none';
    } else {
      graph.variableExportModifier = 'none';
    }
    return true;
  }

  // Case 2: export default defineBuilderConfig(...)
  // NOTE: for `export default expr`, TypeScript's `isExportEquals` is `undefined`,
  // not `false` — only `export = expr` (CommonJS-style) sets it to `true`. A strict
  // `=== false` check here silently never matches real `export default` syntax.
  if (TSContext.ts.isExportAssignment(parent) && parent.isExportEquals !== true) {
    graph.variableExportModifier = 'export default';
    graph.variableStatementStart = parent.getStart();
    return true;
  }

  return false;
}

function propertyAssignment(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  let found: ts.PropertyAssignment | undefined;
  for (const prop of obj.properties) {
    if (TSContext.ts.isPropertyAssignment(prop) && TSContext.ts.isIdentifier(prop.name) && prop.name.text === name) {
      found = prop;
    }
  }
  return found;
}

function configObject(config: ConfigGraph): ts.ObjectLiteralExpression | undefined {
  const arg = config.node.arguments[0];
  return arg && TSContext.ts.isObjectLiteralExpression(arg) ? arg : undefined;
}

/** Every parsed injection of one config, found by the object literal that holds it. */
function infosByNode(config: ConfigGraph): Map<ts.Node, InjectionInfo> {
  const byNode = new Map<ts.Node, InjectionInfo>();
  for (const info of config.localInjections.values()) byNode.set(info.node, info);
  if (config.multiInjections) {
    for (const infos of config.multiInjections.values()) {
      for (const info of infos) byNode.set(info.node, info);
    }
  }
  for (const info of config.duplicates) byNode.set(info.node, info);
  for (const info of config.conflicts ?? []) byNode.set(info.node, info);
  return byNode;
}

function injectionElements(config: ConfigGraph): readonly ts.Expression[] {
  const arg = configObject(config);
  const prop = arg ? propertyAssignment(arg, 'injections') : undefined;
  return prop && TSContext.ts.isArrayLiteralExpression(prop.initializer) ? prop.initializer.elements : [];
}

/**
 * Builds the dependency graphs of the legacy shape from what ConfigCollector collected.
 * A graph is the host builder with the partials it extends merged in extends order, then its own
 * injections, in source order. Nothing here walks the AST for builders or partials again.
 */
export class GraphAdapter {
  private readonly dependencyResolver: DependencyResolver;
  private readonly parentResolver: ParentContainerResolver;
  private readonly parentGraphs = new Map<string, DependencyGraph>();

  constructor(
    private readonly env: AdapterEnv,
    private readonly collection: ConfigCollection,
  ) {
    this.dependencyResolver = new DependencyResolver(env.checker, env.tokens);
    this.parentResolver = new ParentContainerResolver(
      (parent) => this.parentGraphOf(parent),
      (graph) => this.resolve(graph, false),
    );
  }

  /** One graph per defineBuilderConfig call, parents included, in discovery order. */
  graphs(): DependencyGraph[] {
    const graphs: DependencyGraph[] = [];
    for (const entry of this.collection.discovery) {
      if (isRejected(entry)) {
        if (entry.reason === 'shape') throw shapeError(entry.node);
        const graph = emptyGraph();
        if (!positionsOfCall(entry.node, graph)) throw shapeError(entry.node);
        this.stampCall(graph, entry.node);
        rememberCaptureSites(graph);
        this.resolve(graph, true);
        graphs.push(graph);
        continue;
      }
      if (entry.type !== 'builder') continue;
      const graph = emptyGraph();
      if (!positionsOfCall(entry.node, graph)) throw shapeError(entry.node);
      this.stampCall(graph, entry.node);
      this.build(graph, entry);
      this.resolve(graph, true);
      graphs.push(graph);
    }
    return graphs;
  }

  /**
   * One merged graph for the whole program. A builder used as a parent, and a partial
   * extended by a config, are not graphs of their own: they are skipped by identity.
   */
  merged(): DependencyGraph {
    const graph = emptyGraph();
    const parentKeys = new Set<string>();
    const extendedKeys = new Set<string>();
    for (const config of this.collection.configs.values()) {
      if (config.useContainerKey !== undefined) parentKeys.add(config.useContainerKey);
      for (const link of config.extendsLinks ?? []) extendedKeys.add(link.key);
    }
    for (const entry of this.collection.discovery) {
      if (isRejected(entry)) {
        if (entry.reason === 'shape') throw shapeError(entry.node);
        continue;
      }
      const key = entry.containerKey ?? '';
      if (entry.type === 'builder') {
        if (parentKeys.has(key)) continue;
        if (!positionsOfCall(entry.node, graph)) throw shapeError(entry.node);
        this.stampCall(graph, entry.node, false);
        this.build(graph, entry);
        continue;
      }
      if (!TSContext.ts.isVariableDeclaration(entry.node.parent) || extendedKeys.has(key)) continue;
      const partialGraph: DependencyGraph = { containerId: entry.name, nodes: new Map(), roots: [], errors: [] };
      this.build(partialGraph, entry);
      if (partialGraph.errors && partialGraph.errors.length > 0) {
        if (!graph.errors) graph.errors = [];
        graph.errors.push(...partialGraph.errors);
      }
    }
    this.resolve(graph, true);
    return graph;
  }

  /** Where the call sits. The merged graph spans several files, so it names none. */
  private stampCall(graph: DependencyGraph, node: ts.CallExpression, withFile = true): void {
    graph.defineBuilderConfigStart = node.getStart();
    graph.defineBuilderConfigEnd = node.getEnd();
    if (withFile) graph.sourceFileName = node.getSourceFile().fileName.replace(/\\/g, '/');
  }

  /** Parses one config into `graph`, takes its parent tokens and remembers its capture sites. */
  private build(graph: DependencyGraph, config: ConfigGraph): void {
    this.parseInto(graph, config, false, undefined, new Set([config.containerKey ?? '']));
    this.attachParent(graph, config);
    rememberCaptureSites(graph);
  }

  private parentGraphOf(parent: ConfigGraph): DependencyGraph {
    const key = parent.containerKey ?? '';
    const cached = this.parentGraphs.get(key);
    if (cached) return cached;
    const graph: DependencyGraph = { containerId: parent.containerName ?? parent.name, nodes: new Map(), roots: [] };
    // Set before the build: a parent chain that loops reuses the graph under construction.
    this.parentGraphs.set(key, graph);
    this.build(graph, parent);
    return graph;
  }

  private attachParent(graph: DependencyGraph, config: ConfigGraph): void {
    if (config.useContainerRef === null) return;
    if (config.useContainerKind === 'config' && config.useContainerKey !== undefined) {
      const parent = this.collection.configs.get(config.useContainerKey);
      if (parent) this.parentResolver.extractFromConfig(parent, graph);
      return;
    }
    if (config.useContainerKind === 'declared') {
      this.parentResolver.extractFromDeclaredTokens(config.legacyParentTokens, graph);
    }
  }

  /**
   * Replays one config the way the legacy parser built a graph: extended partials first, then the
   * config's own injections, then `useContainer`, then (for a host only) the optimization block.
   * `merge` is true for a partial folded into its host: it keeps the host's name, id and key.
   */
  private parseInto(
    graph: DependencyGraph,
    config: ConfigGraph,
    merge: boolean,
    binding: string | undefined,
    active: Set<string>,
  ): void {
    const configArg = configObject(config);
    if (!configArg) return;

    if (!merge) {
      graph.containerName = config.containerName;
      graph.containerId = config.containerName
        ?? HashUtils.generateContainerId(
          basename(config.sourceFile.fileName, '.ts'),
          config.node.getStart(),
          config.node.getText(),
        );
      graph.containerKey = config.containerKey;
    }

    for (const link of config.extendsLinks ?? []) {
      const partial = this.collection.configs.get(link.key);
      if (!partial || active.has(link.key)) continue;
      active.add(link.key);
      this.parseInto(graph, partial, true, link.binding, active);
      active.delete(link.key);
    }

    this.replayInjections(graph, config, binding, merge);

    // What a folded partial expects from its host, in fold order (nested partials were folded above).
    if (merge && config.expectedExternalTokens && config.expectedExternalTokens.size > 0) {
      graph.expectedExternalTokens ??= new Set();
      for (const tokenId of config.expectedExternalTokens) graph.expectedExternalTokens.add(tokenId);
    }

    if (propertyAssignment(configArg, 'useContainer')) {
      if (!graph.legacyContainers) graph.legacyContainers = [];
      if (!graph.parentProvidedTokens) graph.parentProvidedTokens = new Set();
      if (config.useContainerRef !== null) graph.legacyContainers.push(config.useContainerRef);
    }

    // A merged partial keeps the host optimization. ADR006 lines 9-14.
    if (merge) return;
    graph.optimizationMode = config.optimizationMode;
    graph.publicRoots = config.publicRoots;
    graph.publicMultiRoots = config.publicMultiRoots;
    graph.eagerRoots = config.eagerRoots;
    graph.runtimeProfile = config.runtimeProfile;
    if (config.optimizationErrors && config.optimizationErrors.length > 0) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push(...config.optimizationErrors);
    }
    const closed = closedModeDiagnostics(
      graph.optimizationMode,
      this.env.validation,
      opaqueFactoryNames(graph),
      configArg,
      config.sourceFile,
    );
    if (closed.length > 0) {
      if (!graph.errors) graph.errors = [];
      graph.errors.push(...closed);
    }
  }

  private replayInjections(
    graph: DependencyGraph,
    config: ConfigGraph,
    binding: string | undefined,
    merge: boolean,
  ): void {
    const elements = injectionElements(config);
    const byNode = infosByNode(config);
    const rejected = config.rejectedInjections ?? [];
    elements.forEach((element, index) => {
      const error = rejected.find((candidate) => candidate.node.pos >= element.pos && candidate.node.pos < element.end);
      if (error) {
        // A spread in a partial is only an error once the partial is folded into a host.
        if (TSContext.ts.isSpreadElement(error.node) && binding === undefined) return;
        if (!graph.errors) graph.errors = [];
        graph.errors.push(error);
        return;
      }
      if (!TSContext.ts.isObjectLiteralExpression(element)) return;
      const info = byNode.get(element);
      if (info) this.replay(info, element, graph, binding, index, merge);
    });
  }

  private pushError(graph: DependencyGraph, error: AnalysisError): void {
    if (!graph.errors) graph.errors = [];
    graph.errors.push(error);
  }

  /** The registration, built the way the legacy parser built it for this type and host. */
  private replay(
    info: InjectionInfo,
    obj: ts.ObjectLiteralExpression,
    graph: DependencyGraph,
    binding: string | undefined,
    index: number,
    merge: boolean,
  ): void {
    const collected = info.definition;
    const sourceFile = obj.getSourceFile();
    const { tokenId } = collected;
    const { isMulti, isScoped, tokenText } = info;

    if (collected.type === 'value') {
      if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
      const definition: ServiceDefinition = {
        tokenId,
        registrationNode: obj,
        type: 'value',
        lifecycle: 'singleton',
        isInterfaceToken: collected.isInterfaceToken === true,
        valueSource: collected.valueSource,
        // A direct useValue is hoisted once. A partial reads the property from the expression written in `extends`.
        valueCapture: !binding && merge ? undefined : valueCaptureFor(graph.containerKey, index, binding),
        ownership: collected.ownership,
        isScoped,
      };
      this.addToGraph(isMulti, tokenId, { service: definition, dependencies: [] }, graph);
      return;
    }

    if (collected.type === 'factory') {
      if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
      if (this.emitDuplicate(graph, tokenId, tokenText, isScoped, obj, sourceFile)) return;
      const definition: ServiceDefinition = {
        tokenId,
        tokenSymbol: collected.tokenSymbol,
        registrationNode: obj,
        type: 'factory',
        lifecycle: collected.lifecycle,
        isInterfaceToken: collected.isInterfaceToken === true,
        isValueToken: collected.isValueToken === true,
        factorySource: collected.factorySource,
        isScoped,
        isAsync: collected.isAsync,
        isDisposable: collected.isDisposable,
        isAsyncDisposable: collected.isAsyncDisposable,
        factoryDependencies: collected.factoryDependencies,
        opaque: collected.opaque,
        ownership: collected.ownership,
      };
      for (const warning of info.warnings ?? []) this.pushError(graph, warning);
      this.addToGraph(isMulti, tokenId, { service: definition, dependencies: declaredFactoryEdges(definition) }, graph);
      return;
    }

    // explicit / autowire
    if (!collected.implementationSymbol) return;
    if (this.emitMixedMultiError(isMulti, tokenId, tokenText, obj, graph)) return;
    if (this.emitDuplicate(graph, tokenId, tokenText, isScoped, obj, sourceFile)) return;

    const tokenProperty = propertyAssignment(obj, 'token');
    const providerProperty = propertyAssignment(obj, 'provider');
    if (collected.type === 'explicit' && collected.isInterfaceToken && tokenProperty && providerProperty) {
      this.validateTypeCompatibility(tokenProperty.initializer, providerProperty.initializer, obj, graph);
    }

    const definition: ServiceDefinition = {
      tokenId,
      implementationSymbol: collected.implementationSymbol,
      tokenSymbol: collected.tokenSymbol,
      registrationNode: obj,
      type: collected.type,
      lifecycle: collected.lifecycle,
      isInterfaceToken: collected.isInterfaceToken === true,
      isScoped,
      isDisposable: collected.isDisposable,
      isAsyncDisposable: collected.isAsyncDisposable,
      implementationLocalName: collected.implementationLocalName,
      tokenLocalName: collected.tokenLocalName,
    };
    this.addToGraph(isMulti, tokenId, { service: definition, dependencies: [] }, graph);
  }

  private emitDuplicate(
    graph: DependencyGraph,
    tokenId: TokenId,
    tokenText: string,
    isScoped: boolean,
    obj: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
  ): boolean {
    if (!graph.nodes.has(tokenId) || isScoped) return false;
    this.pushError(graph, {
      type: 'duplicate',
      message: `Duplicate registration: '${tokenText}' is already registered.`,
      node: obj,
      sourceFile,
    });
    return true;
  }

  private addToGraph(isMulti: boolean, tokenId: TokenId, node: DependencyNode, graph: DependencyGraph): void {
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

  /**
   * Emits an error if a token is registered both with and without `multi: true`,
   * counting what the extended partials registered before.
   *
   * @returns true if an error was emitted (caller should return early), false otherwise.
   */
  private emitMixedMultiError(
    isMulti: boolean,
    tokenId: TokenId,
    tokenText: string,
    obj: ts.ObjectLiteralExpression,
    graph: DependencyGraph,
  ): boolean {
    const message = `Token '${tokenText}' is registered both with and without 'multi: true'. All registrations for a token must consistently use multi: true or not at all.`;
    const mixed = isMulti ? graph.nodes.has(tokenId) : graph.multiNodes?.has(tokenId) === true;
    if (!mixed) return false;
    this.pushError(graph, { type: 'duplicate', message, node: obj, sourceFile: obj.getSourceFile() });
    return true;
  }

  /** Type compatibility between an interface token and its explicit provider. */
  private validateTypeCompatibility(
    tokenNode: ts.Node,
    providerNode: ts.Node,
    registrationNode: ts.Node,
    graph: DependencyGraph,
  ): void {
    const { checker, tokens } = this.env;
    let tokenType: ts.Type | undefined;

    // Resolve tokenNode to the actual call expression
    let resolvedTokenNode = tokenNode;
    if (TSContext.ts.isExpression(tokenNode)) {
      const resolved = tokens.resolveToInitializer(tokenNode);
      if (resolved) resolvedTokenNode = resolved;
    }

    if (TSContext.ts.isExpression(resolvedTokenNode) && tokens.isUseInterfaceCall(resolvedTokenNode)) {
      const typeArgs = resolvedTokenNode.typeArguments;
      if (typeArgs && typeArgs.length > 0) tokenType = checker.getTypeFromTypeNode(typeArgs[0]);
    }
    if (!tokenType) return;

    const providerType = checker.getTypeAtLocation(providerNode);
    const constructSignatures = providerType.getConstructSignatures();
    const providerInstanceType = constructSignatures.length > 0 ? constructSignatures[0].getReturnType() : providerType;
    if (!providerInstanceType) return;

    if (checker.isTypeAssignableTo(providerInstanceType, tokenType)) return;
    this.pushError(graph, {
      type: 'type-mismatch',
      message: `Type mismatch: Provider '${checker.typeToString(providerInstanceType)}' is not assignable to token type '${checker.typeToString(tokenType)}'.`,
      node: registrationNode,
      sourceFile: registrationNode.getSourceFile(),
    });
  }

  /**
   * Resolves dependencies for all nodes in the graph. Factory and constructor edges exist.
   * ADR006 lines 21-24. Do not drop nodes here.
   */
  private resolve(graph: DependencyGraph, capture: boolean): void {
    this.dependencyResolver.resolveAll(graph);
    if (graph.multiNodes) {
      for (const nodes of graph.multiNodes.values()) {
        for (const node of nodes) this.dependencyResolver.resolve(node, graph);
      }
    }
    assignRetention(graph);
    sealOpenParent(graph);
    if (!capture) return;
    const validator = new DisposableTransientCaptureValidator(this.env.validation);
    const captured = validator.validateGraph(graph, () => this.parentResolver.ancestorNodes(graph));
    if (captured.length === 0) return;
    if (!graph.errors) graph.errors = [];
    graph.errors.push(...captured);
  }
}

/** One graph per builder of the collection, parents included. */
export function graphsFromSnapshot(env: AdapterEnv, collection: ConfigCollection): DependencyGraph[] {
  return new GraphAdapter(env, collection).graphs();
}

/** The single merged graph `Analyzer.extract()` returns. */
export function mergedGraphFromSnapshot(env: AdapterEnv, collection: ConfigCollection): DependencyGraph {
  return new GraphAdapter(env, collection).merged();
}
