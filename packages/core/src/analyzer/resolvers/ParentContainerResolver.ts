import type { BorrowedRegistration, ConfigGraph, DependencyGraph, DependencyNode, TokenId } from '../types';
import { exportedRootIds } from '../parsers/ConfigParser';


/**
 * Resolves parent container tokens and manages container hierarchy.
 *
 * This service handles the extraction of tokens from parent containers,
 * supporting both:
 * - NeoSyringe containers (defineBuilderConfig/definePartialConfig)
 * - Legacy containers (declareContainerTokens)
 *
 * It also handles transitive parent token inheritance (parent's parent tokens).
 *
 * @example
 * ```typescript
 * const resolver = new ParentContainerResolver((parent) => buildParentGraph(parent));
 *
 * const graph: DependencyGraph = { ... };
 * resolver.extractFromConfig(parentConfig, graph);
 *
 * // graph.parentProvidedTokens now contains all tokens from the parent
 * ```
 */
export class ParentContainerResolver {
  constructor(
    /** Builds the unresolved graph of a parent config from the snapshot. The same parent may be asked for many times. */
    private parentGraphOf: (parent: ConfigGraph) => DependencyGraph,
    private resolveParentGraph?: (graph: DependencyGraph) => void,
  ) {}

  /** Unresolved parent graph. Constructor edges are filled the first time a capture walk needs them. */
  private readonly parentGraphs = new WeakMap<DependencyGraph, DependencyGraph>();
  private readonly resolvedParents = new WeakSet<DependencyGraph>();

  /** Parent registrations, with constructor edges resolved on this call only. */
  ancestorNodes(child: DependencyGraph): DependencyNode[] {
    const nodes: DependencyNode[] = [];
    const seen = new Set<DependencyGraph>();
    let host: DependencyGraph | undefined = child;
    while (host && !seen.has(host)) {
      seen.add(host);
      const parent = this.parentGraphs.get(host);
      if (!parent) break;
      if (!this.resolvedParents.has(parent)) {
        this.resolvedParents.add(parent);
        this.resolveParentGraph?.(parent);
      }
      for (const node of parent.nodes.values()) nodes.push(node);
      if (parent.multiNodes) {
        for (const list of parent.multiNodes.values()) nodes.push(...list);
      }
      host = parent;
    }
    return nodes;
  }

  private linkParent(child: DependencyGraph, parent: DependencyGraph): void {
    this.parentGraphs.set(child, parent);
  }

  /**
   * Takes the tokens of a NeoSyringe parent (defineBuilderConfig/definePartialConfig), found by
   * configuration identity, then those of its own parent (transitive inheritance).
   *
   * @param parent - The collected config named by `useContainer`
   * @param graph - The dependency graph to populate with parent tokens
   */
  extractFromConfig(parent: ConfigGraph, graph: DependencyGraph): void {
    // Ensure parentProvidedTokens is initialized before any sub-call populates it
    if (!graph.parentProvidedTokens) {
      graph.parentProvidedTokens = new Set();
    }

    // Constructor edges stay unresolved until a capture walk needs them.
    const parentGraph = this.parentGraphOf(parent);

    graph.parentProvidedTokens ??= new Set();
    graph.parentResolvableTokens ??= new Set();

    // A closed parent exposes its roots only. ADR006 lines 45-46.
    if (parentGraph.optimizationMode === 'closed') {
      this.copyClosedParent(parentGraph, graph);
      return;
    }

    // Add all parent tokens to parentProvidedTokens. Only interface tokens are
    // also added to parentResolvableTokens — the parent's generated resolveLocal()
    // matches those by string, so a child can safely delegate to them via
    // this.resolve(tokenId). Bare class tokens match by identity instead; the
    // symbol needed to reference that class from the child's own generated code
    // is captured separately in parentClassTokenSymbols (see field doc).
    for (const [tokenId, node] of parentGraph.nodes) {
      graph.parentProvidedTokens.add(tokenId);
      if (node.service.isInterfaceToken) {
        graph.parentResolvableTokens.add(tokenId);
      } else {
        const symbol = node.service.tokenSymbol ?? node.service.implementationSymbol;
        if (symbol) {
          graph.parentClassTokenSymbols ??= new Map();
          graph.parentClassTokenSymbols.set(tokenId, symbol);
        }
      }
    }

    // Multi registrations are not in nodes. { all: token } keeps that token id.
    if (parentGraph.multiNodes) {
      for (const [tokenId, nodes] of parentGraph.multiNodes) {
        const node = nodes[0];
        graph.parentProvidedTokens.add(tokenId);
        if (node?.service.isInterfaceToken) {
          graph.parentResolvableTokens.add(tokenId);
        } else {
          const symbol = node?.service.tokenSymbol ?? node?.service.implementationSymbol;
          if (symbol) {
            graph.parentClassTokenSymbols ??= new Map();
            graph.parentClassTokenSymbols.set(tokenId, symbol);
          }
        }
      }
    }

    // Also inherit parent's parent tokens (transitive inheritance)
    if (parentGraph.parentProvidedTokens) {
      for (const tokenId of parentGraph.parentProvidedTokens) {
        graph.parentProvidedTokens.add(tokenId);
      }
    }
    if (parentGraph.parentResolvableTokens) {
      for (const tokenId of parentGraph.parentResolvableTokens) {
        graph.parentResolvableTokens.add(tokenId);
      }
    }
    if (parentGraph.parentClassTokenSymbols) {
      graph.parentClassTokenSymbols ??= new Map();
      for (const [tokenId, symbol] of parentGraph.parentClassTokenSymbols) {
        graph.parentClassTokenSymbols.set(tokenId, symbol);
      }
    }

    // Propagate "needs initialize()" up the chain: a child with no async
    // factories of its own still needs to cascade into a parent that has them
    // (directly, or transitively through the parent's own parent).
    if (this.hasAsyncFactories(parentGraph) || parentGraph.parentHasAsyncInitialize) {
      graph.parentHasAsyncInitialize = true;
    }

    this.recordBorrowed(parentGraph, graph);
    this.linkParent(graph, parentGraph);
  }

  /**
   * Copies only the parent's exported roots. Private registrations stay on the parent.
   * ADR006 lines 45-46.
   */
  private copyClosedParent(parentGraph: DependencyGraph, graph: DependencyGraph): void {
    const exposed = exportedRootIds(parentGraph);
    const allow = new Set<TokenId>([...exposed.single, ...exposed.multi]);
    const take = (tokenId: TokenId, node: DependencyNode | undefined) => {
      if (!allow.has(tokenId)) return;
      graph.parentProvidedTokens?.add(tokenId);
      if (node?.service.isInterfaceToken) {
        graph.parentResolvableTokens?.add(tokenId);
        return;
      }
      const symbol = node?.service.tokenSymbol ?? node?.service.implementationSymbol;
      if (!symbol) return;
      graph.parentClassTokenSymbols ??= new Map();
      graph.parentClassTokenSymbols.set(tokenId, symbol);
    };
    for (const [tokenId, node] of parentGraph.nodes) take(tokenId, node);
    if (parentGraph.multiNodes) {
      for (const [tokenId, nodes] of parentGraph.multiNodes) take(tokenId, nodes[0]);
    }
    if (this.exposedAsync(parentGraph, allow)) graph.parentHasAsyncInitialize = true;
    this.recordBorrowed(parentGraph, graph, allow);
    this.linkParent(graph, parentGraph);
  }

  /** Async work that a child must cascade into. Pruned providers do not count. */
  private exposedAsync(parentGraph: DependencyGraph, allow: Set<TokenId>): boolean {
    for (const [tokenId, node] of parentGraph.nodes) {
      if (allow.has(tokenId) && node.service.isAsync) return true;
    }
    if (!parentGraph.multiNodes) return false;
    for (const [tokenId, nodes] of parentGraph.multiNodes) {
      if (allow.has(tokenId) && nodes.some((node) => node.service.isAsync)) return true;
    }
    return false;
  }

  /** Records parent registrations borrowed by the child. The container id is the parent key. */
  private recordBorrowed(parentGraph: DependencyGraph, graph: DependencyGraph, allow?: Set<TokenId>): void {
    const containerId = parentGraph.containerKey;
    if (!containerId) return;
    const borrowed: BorrowedRegistration[] = [];
    const push = (node: DependencyNode) => {
      if (allow && !allow.has(node.service.tokenId)) return;
      const registrationId = node.service.registrationId;
      if (!registrationId) return;
      borrowed.push({ registrationId, tokenId: node.service.tokenId, containerId });
    };
    for (const node of parentGraph.nodes.values()) push(node);
    if (parentGraph.multiNodes) {
      for (const nodes of parentGraph.multiNodes.values()) {
        for (const node of nodes) push(node);
      }
    }
    if (borrowed.length === 0) return;
    graph.borrowedRegistrations = [...(graph.borrowedRegistrations ?? []), ...borrowed];
  }

  /** Minimal local check — avoids a reverse dependency on the generator package. */
  private hasAsyncFactories(graph: DependencyGraph): boolean {
    for (const node of graph.nodes.values()) {
      if (node.service.isAsync) return true;
    }
    if (graph.multiNodes) {
      for (const nodes of graph.multiNodes.values()) {
        if (nodes.some((node) => node.service.isAsync)) return true;
      }
    }
    return false;
  }

  /**
   * Takes the tokens of a legacy container declared with declareContainerTokens<{ Token: Type }>().
   *
   * declareContainerTokens() bridges to a legacy container that is always resolved
   * by string key (that's the whole point of the shim), regardless of whether the
   * declared type is a class or an interface, so every entry is resolvable.
   *
   * @param tokens - Token ids read from the declared type by the collector
   * @param graph - The graph to populate with declared tokens
   */
  extractFromDeclaredTokens(tokens: ReadonlySet<TokenId> | undefined, graph: DependencyGraph): void {
    if (!tokens) return;

    graph.parentProvidedTokens ??= new Set();
    graph.parentResolvableTokens ??= new Set();

    for (const tokenId of tokens) {
      graph.parentProvidedTokens.add(tokenId);
      graph.parentResolvableTokens.add(tokenId);
    }
  }

}
