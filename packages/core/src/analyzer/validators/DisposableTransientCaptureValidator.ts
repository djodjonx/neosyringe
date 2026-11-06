import type * as ts from 'typescript';
import type { AnalysisError, ConfigGraph, DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import { getSimpleName } from '../utils/TokenUtils';

const MESSAGE =
  "A transient is owned by the caller and is never closed by the container. Register it as a singleton, or construct it inside the singleton and close it from that service's own dispose.";

interface Edge {
  tokenId: TokenId;
}

interface View {
  tokenId: TokenId;
  name: string;
  lifecycle: 'singleton' | 'transient';
  isScoped: boolean;
  isDisposable: boolean;
  isAsyncDisposable: boolean;
  ownership?: 'owned' | 'borrowed';
  edges: Edge[];
  node: ts.Node;
  sourceFile: ts.SourceFile;
  fromParent: boolean;
}

interface CaptureSite {
  containerId?: string;
  label: string;
}

const sites = new WeakMap<DependencyGraph, Map<ts.Node, CaptureSite>>();

/** Records the container key and label while this graph still owns them. */
export function rememberCaptureSites(graph: DependencyGraph): void {
  const map = sites.get(graph) ?? new Map<ts.Node, CaptureSite>();
  sites.set(graph, map);
  const site: CaptureSite = {
    containerId: graph.containerKey,
    label: graph.containerName ?? graph.containerId,
  };
  const take = (node: DependencyNode) => {
    if (!map.has(node.service.registrationNode)) map.set(node.service.registrationNode, site);
  };
  for (const node of graph.nodes.values()) take(node);
  if (graph.multiNodes) {
    for (const list of graph.multiNodes.values()) {
      for (const node of list) take(node);
    }
  }
}

function captureSite(graph: DependencyGraph, node: ts.Node): CaptureSite {
  return sites.get(graph)?.get(node) ?? {
    containerId: graph.containerKey,
    label: graph.containerName ?? graph.containerId,
  };
}

/** Constructor edges plus factory `dependencies`, simple or `{ all }`. */
export function captureEdgesOf(service: ServiceDefinition): Edge[] {
  const edges: Edge[] = [];
  for (const edge of service.dependencyEdges ?? []) {
    edges.push({ tokenId: edge.tokenId });
  }
  for (const dep of service.factoryDependencies ?? []) {
    edges.push({ tokenId: dep.tokenId });
  }
  return edges;
}

function isCaptor(view: View): boolean {
  if (view.fromParent) return false;
  return view.lifecycle === 'singleton';
}

function isCapturedTransient(view: View): boolean {
  if (view.lifecycle === 'singleton') return false;
  return view.isDisposable || view.isAsyncDisposable;
}

/**
 * Refuses a disposable transient that a singleton captures.
 * A non-disposable transient stays allowed. The walk stops at a singleton.
 */
export class DisposableTransientCaptureValidator implements IValidator {
  readonly name = 'DisposableTransientCaptureValidator';

  private parentTokens: Set<TokenId> | undefined;
  private loadAncestors: (() => readonly DependencyNode[]) | undefined;
  private ancestorsLoaded = false;
  private siteGraph: DependencyGraph | undefined;
  private container: CaptureSite = { label: 'container' };

  constructor(private readonly validation: 'strict' | 'compatible') {}

  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
    this.parentTokens = undefined;
    this.loadAncestors = undefined;
    this.ancestorsLoaded = false;
    this.siteGraph = undefined;
    this.container = {
      containerId: config.containerKey,
      label: config.containerName ?? config.name,
    };
    const registry = new Map<TokenId, View[]>();
    const captors: View[] = [];
    this.addViews(this.viewsOf(config, false), registry, captors, false);
    for (const partial of this.extended(config, context.allConfigs)) {
      this.addViews(this.viewsOf(partial, false), registry, captors, false);
    }
    for (const parent of this.parentsOf(config, context.allConfigs)) {
      this.addViews(this.viewsOf(parent, true), registry, captors, true);
      for (const partial of this.extended(parent, context.allConfigs)) {
        this.addViews(this.viewsOf(partial, true), registry, captors, true);
      }
    }
    return this.collect(captors, registry);
  }

  validateGraph(
    graph: DependencyGraph,
    loadAncestors?: () => readonly DependencyNode[],
  ): AnalysisError[] {
    this.parentTokens = graph.parentProvidedTokens;
    this.loadAncestors = loadAncestors;
    this.ancestorsLoaded = false;
    this.siteGraph = graph;
    this.container = {
      containerId: graph.containerKey,
      label: graph.containerName ?? graph.containerId,
    };
    const registry = new Map<TokenId, View[]>();
    const captors: View[] = [];
    const locals: View[] = [];
    for (const node of graph.nodes.values()) locals.push(this.viewFromNode(node, false));
    if (graph.multiNodes) {
      for (const nodes of graph.multiNodes.values()) {
        for (const node of nodes) locals.push(this.viewFromNode(node, false));
      }
    }
    this.addViews(locals, registry, captors, false);
    return this.collect(captors, registry);
  }

  private viewsOf(config: ConfigGraph, fromParent: boolean): View[] {
    const views: View[] = [];
    for (const info of config.localInjections.values()) views.push(this.viewFromService(info.definition, fromParent));
    if (config.multiInjections) {
      for (const infos of config.multiInjections.values()) {
        for (const info of infos) views.push(this.viewFromService(info.definition, fromParent));
      }
    }
    return views;
  }

  private viewFromNode(node: DependencyNode, fromParent: boolean): View {
    return this.viewFromService(node.service, fromParent);
  }

  private viewFromService(service: ServiceDefinition, fromParent: boolean): View {
    return {
      tokenId: service.tokenId,
      name: getSimpleName(service.tokenId),
      lifecycle: service.lifecycle,
      isScoped: service.isScoped === true,
      isDisposable: service.isDisposable === true,
      isAsyncDisposable: service.isAsyncDisposable === true,
      ownership: service.ownership,
      edges: captureEdgesOf(service),
      node: service.registrationNode,
      sourceFile: service.registrationNode.getSourceFile(),
      fromParent,
    };
  }

  private addViews(views: readonly View[], registry: Map<TokenId, View[]>, captors: View[], fromParent: boolean): void {
    for (const view of views) {
      if (fromParent && registry.has(view.tokenId)) continue;
      const list = registry.get(view.tokenId) ?? [];
      list.push(view);
      registry.set(view.tokenId, list);
      if (!fromParent) captors.push(view);
    }
  }

  private extended(config: ConfigGraph, all: Map<string, ConfigGraph>): ConfigGraph[] {
    const out: ConfigGraph[] = [];
    for (const name of config.extendsRefs) {
      const partial = this.byName(all, name);
      if (partial) out.push(partial);
    }
    return out;
  }

  private parentsOf(config: ConfigGraph, all: Map<string, ConfigGraph>): ConfigGraph[] {
    const out: ConfigGraph[] = [];
    const seen = new Set<string>();
    let cursor: ConfigGraph | undefined = config;
    while (cursor?.useContainerRef) {
      const name = cursor.useContainerRef;
      if (seen.has(name)) break;
      seen.add(name);
      const parent = this.byName(all, name);
      if (!parent) break;
      out.push(parent);
      cursor = parent;
    }
    return out;
  }

  private byName(all: Map<string, ConfigGraph>, name: string): ConfigGraph | undefined {
    for (const config of all.values()) {
      if (config.name === name) return config;
    }
    return undefined;
  }

  private armParent(captors: readonly View[], registry: Map<TokenId, View[]>): void {
    if (!this.parentTokens || !this.loadAncestors) return;
    for (const captor of captors) {
      if (!isCaptor(captor)) continue;
      for (const edge of captor.edges) {
        if (!this.parentTokens.has(edge.tokenId)) continue;
        this.pullAncestors(registry);
        return;
      }
    }
  }

  private pullAncestors(registry: Map<TokenId, View[]>): void {
    if (this.ancestorsLoaded || !this.loadAncestors) return;
    this.ancestorsLoaded = true;
    const views = this.loadAncestors().map((node) => this.viewFromNode(node, true));
    this.addViews(views, registry, [], true);
  }

  private collect(captors: readonly View[], registry: Map<TokenId, View[]>): AnalysisError[] {
    const errors: AnalysisError[] = [];
    const reported = new Set<string>();
    this.armParent(captors, registry);
    for (const captor of captors) {
      if (!isCaptor(captor)) continue;
      const seen = new Set<TokenId>([captor.tokenId]);
      for (const edge of captor.edges) {
        this.descend(captor, edge.tokenId, [captor.name], seen, registry, errors, reported);
      }
    }
    return errors;
  }

  private descend(
    captor: View,
    tokenId: TokenId,
    names: string[],
    seen: Set<TokenId>,
    registry: Map<TokenId, View[]>,
    errors: AnalysisError[],
    reported: Set<string>,
  ): void {
    let targets = registry.get(tokenId);
    if ((!targets || targets.length === 0) && this.parentTokens?.has(tokenId)) {
      this.pullAncestors(registry);
      targets = registry.get(tokenId);
    }
    if (!targets || targets.length === 0) return;
    for (const target of targets) {
      if (seen.has(target.tokenId)) continue;
      if (target.lifecycle === 'singleton') continue;
      const chain = [...names, target.name];
      if (isCapturedTransient(target)) {
        this.report(captor, target, chain, errors, reported);
        continue;
      }
      const next = new Set(seen);
      next.add(target.tokenId);
      for (const child of target.edges) {
        this.descend(captor, child.tokenId, chain, next, registry, errors, reported);
      }
    }
  }

  private report(
    captor: View,
    captured: View,
    chain: string[],
    errors: AnalysisError[],
    reported: Set<string>,
  ): void {
    const key = `${captor.node.getStart()}\0${captured.tokenId}`;
    if (reported.has(key)) return;
    reported.add(key);
    errors.push(this.makeError(captor, captured, chain));
  }

  private makeError(captor: View, captured: View, chain: string[]): AnalysisError {
    const site = this.siteGraph ? captureSite(this.siteGraph, captor.node) : this.container;
    return {
      type: 'unsupported',
      code: 'NEO_DISPOSABLE_TRANSIENT_CAPTURED',
      severity: this.validation === 'compatible' ? 'warning' : 'error',
      message: `NEO_DISPOSABLE_TRANSIENT_CAPTURED: container '${site.label}' singleton '${captor.name}' captures disposable transient '${captured.name}'. ${MESSAGE}`,
      node: captor.node,
      sourceFile: captor.sourceFile,
      context: { tokenText: captured.tokenId, chain },
      containerId: site.containerId,
    };
  }
}
