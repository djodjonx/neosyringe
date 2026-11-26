import path from 'node:path';
import type * as ts from 'typescript';
import type { AnalysisError, DependencyGraph, DependencyNode, TokenId } from './types';
import { stableCodeOf, stableSeverityOf } from './errors/stableDiagnostic';

/**
 * The compiler-free shape of one analyzed container (topic 03). It holds no `ts.Node`, `ts.Symbol`
 * or `ts.Type`: every position is a file, an offset and a length. Alias and scope-entry fields are
 * added by topics 18 and 20; nothing here anticipates them.
 */
export interface SourceSpan {
  readonly file: string;
  readonly start: number;
  readonly length: number;
}

export type DependencyRef =
  | { readonly kind: 'local'; readonly registration: string }
  | { readonly kind: 'all'; readonly token: string; readonly registrations: readonly string[] }
  | { readonly kind: 'parent'; readonly token: string; readonly parent: string }
  /** A dependency no registration, parent or declared container provides. The diagnostics say why; the IR keeps the edge. */
  | { readonly kind: 'unresolved'; readonly token: string; readonly optional: boolean };

export interface RegistrationIR {
  readonly id: string;
  readonly token: string;
  readonly order: number;
  readonly provider: {
    readonly kind: 'class' | 'factory' | 'value' | 'input';
    readonly expressionRef: string;
  };
  readonly lifecycle: 'singleton' | 'transient';
  readonly ownership: 'owned' | 'borrowed' | 'caller';
  readonly async: boolean;
  readonly multi: boolean;
  readonly dependencies: readonly DependencyRef[];
  readonly origin: SourceSpan;
}

export interface DiagnosticIR {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly origin: SourceSpan;
  readonly related: readonly SourceSpan[];
  readonly chain: readonly string[];
}

export interface ContainerIR {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: 'open' | 'closed';
  readonly profile: 'full' | 'minimal';
  readonly registrations: readonly RegistrationIR[];
  readonly publicRoots: readonly DependencyRef[];
  readonly eagerRoots: readonly DependencyRef[];
  /** The scope inputs, in declared order. Absent when the container has none. Each one is also a registration. */
  readonly inputs?: readonly { readonly token: string; readonly slot: number }[];
  readonly diagnostics: readonly DiagnosticIR[];
}

/** Not the full validator: cycles, types, optionality and captures stay with the analyzer. */
export function assertLocalReferences(graph: ContainerIR): void {
  const ids = new Set(graph.registrations.map(registration => registration.id));
  if (ids.size !== graph.registrations.length) throw new Error('duplicate registration id');
  for (const registration of graph.registrations) {
    for (const dependency of registration.dependencies) {
      const targets = dependency.kind === 'local' ? [dependency.registration]
        : dependency.kind === 'all' ? dependency.registrations : [];
      if (targets.some(id => !ids.has(id))) throw new Error('invalid local reference');
    }
  }
}

function spanOf(node: ts.Node, root: string): SourceSpan {
  const file = node.getSourceFile();
  const start = node.getStart(file);
  return {
    file: path.relative(root, file.fileName).split(path.sep).join('/'),
    start,
    length: node.getEnd() - start,
  };
}

export function diagnosticIROf(error: AnalysisError, root: string): DiagnosticIR {
  return {
    code: stableCodeOf(error) ?? error.type,
    severity: stableSeverityOf(error),
    message: error.message,
    origin: spanOf(error.node, root),
    related: [],
    chain: error.context?.chain ? [...error.context.chain] : [],
  };
}

interface Located {
  readonly tokenId: TokenId;
  readonly node: DependencyNode;
  readonly multi: boolean;
  readonly index: number;
}

function registrationId(located: Located): string {
  const stamped = located.node.service.registrationId;
  if (stamped && stamped.length > 0) return stamped;
  return located.multi ? `multi:${located.tokenId}:${located.index}` : located.tokenId;
}

function providerOf(node: DependencyNode, id: string): RegistrationIR['provider'] {
  const { service } = node;
  if (service.type === 'factory') return { kind: 'factory', expressionRef: `factory:${id}` };
  if (service.inputSlot !== undefined) return { kind: 'input', expressionRef: `input:${id}` };
  if (service.type === 'value') return { kind: 'value', expressionRef: `value:${id}` };
  return { kind: 'class', expressionRef: service.implementationSymbol?.getName() ?? service.tokenId };
}

/**
 * One graph as a container IR. Registrations keep the graph's order: simple registrations first, then
 * every contribution of a multi token, in the order the graph holds them. Nothing is sorted.
 */
export function containerIROf(graph: DependencyGraph, root: string): ContainerIR {
  const located: Located[] = [];
  for (const [tokenId, node] of graph.nodes) located.push({ tokenId, node, multi: false, index: 0 });
  if (graph.multiNodes) {
    for (const [tokenId, nodes] of graph.multiNodes) {
      nodes.forEach((node, index) => located.push({ tokenId, node, multi: true, index }));
    }
  }
  const single = new Map<TokenId, string>();
  const multi = new Map<TokenId, string[]>();
  const ids = located.map(registrationId);
  located.forEach((entry, position) => {
    const id = ids[position] as string;
    if (entry.multi) {
      const list = multi.get(entry.tokenId) ?? [];
      list.push(id);
      multi.set(entry.tokenId, list);
    } else {
      single.set(entry.tokenId, id);
    }
  });
  const parentOf = (token: TokenId): string | undefined =>
    graph.borrowedRegistrations?.find((item) => item.tokenId === token)?.containerId;

  // A token a declareContainerTokens parent provides has no borrowed registration: the container is named
  // by what the user wrote in `useContainer`.
  const declaredParent = graph.legacyContainers?.[0] !== undefined ? `declared:${graph.legacyContainers[0]}` : undefined;

  const refFor = (token: TokenId, all: boolean): DependencyRef | undefined => {
    const contributions = multi.get(token);
    if (all || contributions) return { kind: 'all', token, registrations: contributions ?? [] };
    const local = single.get(token);
    if (local !== undefined) return { kind: 'local', registration: local };
    const parent = parentOf(token);
    if (parent !== undefined) return { kind: 'parent', token, parent };
    if (graph.parentProvidedTokens?.has(token) && declaredParent !== undefined) {
      return { kind: 'parent', token, parent: declaredParent };
    }
    return undefined;
  };

  const registrations: RegistrationIR[] = located.map((entry, position) => {
    const id = ids[position] as string;
    const { service } = entry.node;
    const dependencies: DependencyRef[] = [];
    for (const token of entry.node.dependencies) {
      const ref = refFor(token, false);
      dependencies.push(ref ?? { kind: 'unresolved', token, optional: entry.node.optionalDependencies?.has(token) === true });
    }
    return {
      id,
      token: entry.tokenId,
      order: position,
      provider: providerOf(entry.node, id),
      lifecycle: service.lifecycle,
      ownership: service.ownership === 'borrowed' ? 'borrowed' : service.lifecycle === 'transient' ? 'caller' : 'owned',
      async: service.isAsync === true,
      multi: entry.multi,
      dependencies,
      origin: spanOf(service.registrationNode, root),
    };
  });

  const rootsOf = (tokens: readonly TokenId[] | undefined, all: boolean): DependencyRef[] => {
    const refs: DependencyRef[] = [];
    for (const token of tokens ?? []) {
      const ref = refFor(token, all);
      if (ref) refs.push(ref);
    }
    return refs;
  };

  return {
    schemaVersion: 1,
    id: graph.containerKey ?? graph.containerId,
    mode: graph.optimizationMode === 'closed' ? 'closed' : 'open',
    profile: graph.runtimeProfile === 'minimal' ? 'minimal' : 'full',
    registrations,
    publicRoots: [...rootsOf(graph.publicRoots, false), ...rootsOf(graph.publicMultiRoots, true)],
    eagerRoots: (graph.eagerRoots ?? []).flatMap((token) => {
      const ref = refFor(token, multi.has(token));
      return ref ? [ref] : [];
    }),
    ...(graph.scopeInputs && graph.scopeInputs.length > 0
      ? { inputs: graph.scopeInputs.map((input) => ({ token: input.tokenId, slot: input.slot })) }
      : {}),
    diagnostics: (graph.errors ?? []).map((error) => diagnosticIROf(error, root)),
  };
}
