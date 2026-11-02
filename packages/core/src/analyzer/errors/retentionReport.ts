import type { DependencyGraph, DependencyNode, RetentionReason, TokenId } from '../types';
import { getSimpleName } from '../utils/TokenUtils';

export type RetentionCause =
  | 'root'
  | 'eager'
  | 'dependency-of'
  | 'multi-contribution-of'
  | 'open-parent'
  | 'opaque-boundary'
  | 'unreachable';

export interface RetentionEntry {
  registrationId: string;
  token: string;
  cause: RetentionCause;
  path: string[];
}

export interface RetentionContainerReport {
  containerKey: string;
  containerName?: string;
  sourceFile: string;
  entries: RetentionEntry[];
}

export interface RetentionReport {
  schemaVersion: 1;
  containers: RetentionContainerReport[];
}

export interface ExplainResult {
  found: boolean;
  token: string;
  /** `false` when `container` matched no container at all. Absent otherwise. */
  containerFound?: false;
  /** The container filter that matched nothing. Set only with `containerFound: false`. */
  container?: string;
  containerKey?: string;
  containerName?: string;
  sourceFile?: string;
  registrationId?: string;
  cause?: RetentionCause;
  path?: string[];
}

export interface ExplainReport {
  schemaVersion: 1;
  results: ExplainResult[];
}

export interface ExplainOptions {
  /** Container key or container name. Absent explains every container. */
  container?: string;
  /** Source files are written relative to this directory when set. */
  cwd?: string;
}

/** Same key as the retention map: the registration id, else the token id. */
function registrationKey(node: DependencyNode, tokenId: TokenId): string {
  return node.service.registrationId ?? tokenId;
}

interface Registration {
  key: string;
  tokenId: TokenId;
  node: DependencyNode;
}

/** Simple registrations first, then multi contributions, each in registration order. */
function registrationsOf(graph: DependencyGraph): Registration[] {
  const registrations: Registration[] = [];
  for (const [tokenId, node] of graph.nodes) registrations.push({ key: registrationKey(node, tokenId), tokenId, node });
  for (const [tokenId, nodes] of graph.multiNodes ?? []) {
    for (const node of nodes) registrations.push({ key: registrationKey(node, tokenId), tokenId, node });
  }
  return registrations;
}

function causeOf(reason: RetentionReason, node: DependencyNode): RetentionCause {
  if (reason.kind !== 'parent-boundary') return reason.kind;
  return node.service.opaque === true ? 'opaque-boundary' : 'open-parent';
}

/**
 * Root first. Walks the recorded `dependency-of` and `multi-contribution-of` tokens.
 * A registration seen twice ends the walk, so a cycle cannot loop.
 */
function pathOf(
  start: Registration,
  reasons: ReadonlyMap<string, RetentionReason>,
  byToken: ReadonlyMap<TokenId, Registration>,
): string[] {
  const reversed = [getSimpleName(start.tokenId)];
  const seen = new Set<string>([start.key]);
  let reason = reasons.get(start.key);
  while (reason && (reason.kind === 'dependency-of' || reason.kind === 'multi-contribution-of')) {
    const requester = byToken.get(reason.token);
    if (!requester || seen.has(requester.key)) break;
    seen.add(requester.key);
    reversed.push(getSimpleName(requester.tokenId));
    reason = reasons.get(requester.key);
  }
  return reversed.reverse();
}

/**
 * One entry per registration of a graph, read from `graph.retention`.
 * Nothing is recomputed: a graph without `retention` has no entries.
 */
export function retentionEntries(graph: DependencyGraph): RetentionEntry[] {
  const reasons = graph.retention;
  if (!reasons) return [];
  const registrations = registrationsOf(graph);
  const byToken = new Map<TokenId, Registration>();
  for (const registration of registrations) {
    if (!byToken.has(registration.tokenId)) byToken.set(registration.tokenId, registration);
  }
  const entries: RetentionEntry[] = [];
  for (const registration of registrations) {
    const reason = reasons.get(registration.key);
    if (!reason) continue;
    const cause = causeOf(reason, registration.node);
    entries.push({
      registrationId: registration.key,
      token: getSimpleName(registration.tokenId),
      cause,
      path: cause === 'unreachable' ? [] : pathOf(registration, reasons, byToken),
    });
  }
  return entries;
}

function displayPath(file: string | undefined, cwd: string | undefined): string {
  const normal = (file ?? '').replace(/\\/g, '/');
  if (!cwd) return normal;
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return normal.startsWith(`${base}/`) ? normal.slice(base.length + 1) : normal;
}

function containerKeyOf(graph: DependencyGraph): string {
  return graph.containerKey ?? graph.containerId;
}

function containerReport(graph: DependencyGraph, cwd: string | undefined): RetentionContainerReport {
  return {
    containerKey: containerKeyOf(graph),
    ...(graph.containerName !== undefined ? { containerName: graph.containerName } : {}),
    sourceFile: displayPath(graph.sourceFileName, cwd),
    entries: retentionEntries(graph),
  };
}

/**
 * Versioned report of every container. Containers are identified by `containerKey`,
 * never by name. The report carries causes and paths only: no size, no service values.
 */
export function buildRetentionReport(graphs: DependencyGraph[], cwd?: string): RetentionReport {
  return { schemaVersion: 1, containers: graphs.map((graph) => containerReport(graph, cwd)) };
}

function matchesContainer(graph: DependencyGraph, wanted: string): boolean {
  return containerKeyOf(graph) === wanted || graph.containerName === wanted || graph.containerId === wanted;
}

/**
 * Why a token is kept, per container. The token is a simple name, else a full token id.
 * With `container`, only containers whose key (else name) matches are asked.
 * A token found nowhere yields `found: false`, naming each asked container when `container` is set.
 * A `container` that matches nothing yields one `containerFound: false` result carrying that filter.
 */
export function explainRetention(graphs: DependencyGraph[], token: string, options: ExplainOptions = {}): ExplainReport {
  const wanted = options.container;
  let asked = graphs;
  if (wanted !== undefined) {
    const byKey = graphs.filter((graph) => containerKeyOf(graph) === wanted);
    asked = byKey.length > 0 ? byKey : graphs.filter((graph) => matchesContainer(graph, wanted));
  }
  if (wanted !== undefined && asked.length === 0) {
    return { schemaVersion: 1, results: [{ found: false, token, containerFound: false, container: wanted }] };
  }
  const hits: ExplainResult[] = [];
  const misses: ExplainResult[] = [];
  for (const graph of asked) {
    const container = containerReport(graph, options.cwd);
    const matches = registrationsOf(graph).filter((registration) =>
      getSimpleName(registration.tokenId) === token || registration.tokenId === token);
    const found = container.entries.filter((entry) =>
      matches.some((registration) => registration.key === entry.registrationId));
    const identity = {
      containerKey: container.containerKey,
      ...(container.containerName !== undefined ? { containerName: container.containerName } : {}),
      sourceFile: container.sourceFile,
    };
    for (const entry of found) {
      hits.push({ found: true, token, ...identity, registrationId: entry.registrationId, cause: entry.cause, path: entry.path });
    }
    if (found.length === 0 && wanted !== undefined) misses.push({ found: false, token, ...identity });
  }
  if (hits.length > 0) return { schemaVersion: 1, results: hits };
  return { schemaVersion: 1, results: misses.length > 0 ? misses : [{ found: false, token }] };
}
