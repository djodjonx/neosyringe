import type { AnalysisError, AnalysisErrorType, DependencyGraph, DiagnosticCode } from '../types';
import { getSimpleName } from '../utils/TokenUtils';

/** The machine contract of one diagnostic. Messages may change; `code` and `severity` do not. */
export interface StableDiagnostic {
  code?: DiagnosticCode;
  severity: 'error' | 'warning';
  message: string;
  /** `sourceFile.fileName`, as the analyzer saw it. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  type: AnalysisErrorType;
  /** `containerKey` of the container the diagnostic was checked against, when known (set by the analyzer or by a lookup). */
  containerId?: string;
  /** Name of the owning container, when a lookup knew it. */
  containerName?: string;
  /** Source file of the owning container, when a lookup knew it. */
  containerFile?: string;
  /** Readable name of the token the diagnostic is about. */
  token?: string;
  /** Dependency chain, copied from `context.chain` only. */
  chain?: string[];
}

/** The container a diagnostic belongs to, as a consumer found it from the analyzed graphs. */
export interface ContainerOwner {
  containerKey: string;
  containerName?: string;
  sourceFile: string;
}

/** Finds the container an error belongs to. `undefined` when it cannot be told apart. */
export type ContainerLookup = (error: AnalysisError) => ContainerOwner | undefined;

function containerKeyOf(graph: DependencyGraph): string {
  return graph.containerKey ?? graph.containerId;
}

function ownerOf(graph: DependencyGraph): ContainerOwner {
  return {
    containerKey: containerKeyOf(graph),
    ...(graph.containerName !== undefined ? { containerName: graph.containerName } : {}),
    sourceFile: graph.sourceFileName ?? '',
  };
}

/** Graphs of the error's source file whose config range (`defineBuilderConfigStart..End`) holds the error's node. */
function graphsWithNodeInRange(graphs: readonly DependencyGraph[], error: AnalysisError): DependencyGraph[] {
  const fileName = error.sourceFile.fileName.replace(/\\/g, '/');
  const position = error.node.getStart(error.sourceFile);
  return graphs.filter((graph) =>
    graph.sourceFileName === fileName
    && graph.defineBuilderConfigStart !== undefined
    && graph.defineBuilderConfigEnd !== undefined
    && position >= graph.defineBuilderConfigStart
    && position < graph.defineBuilderConfigEnd);
}

/**
 * The graphs that own an error, the only ones a container may be named from:
 * 1. `error.containerId` is the `containerKey` of a graph: that graph.
 * 2. Else the graphs of the error's source file whose config range contains the error's node.
 * Empty when neither rule matches (a resolve call site, a partial config): the error is unowned.
 */
function owningGraphs(graphs: readonly DependencyGraph[], error: AnalysisError): DependencyGraph[] {
  if (error.containerId !== undefined) {
    const owner = graphs.find((graph) => containerKeyOf(graph) === error.containerId);
    if (owner) return [owner];
  }
  return graphsWithNodeInRange(graphs, error);
}

/**
 * The graphs an error is listed under: its owners, else every graph of its source file
 * (still visible, owned by none). Empty when no graph has the error's source file.
 */
function candidateGraphs(graphs: readonly DependencyGraph[], error: AnalysisError): DependencyGraph[] {
  const owners = owningGraphs(graphs, error);
  if (owners.length > 0) return owners;
  const fileName = error.sourceFile.fileName.replace(/\\/g, '/');
  return graphs.filter((graph) => graph.sourceFileName === fileName);
}

/**
 * Splits analyzer errors between graphs with the rules of `candidateGraphs`.
 * An error that fits several graphs, or none, is listed under each graph it may belong to.
 */
export function attributeErrors(
  graphs: readonly DependencyGraph[],
  errors: readonly AnalysisError[],
): Map<DependencyGraph, AnalysisError[]> {
  const attributed = new Map<DependencyGraph, AnalysisError[]>(graphs.map((graph) => [graph, []]));
  for (const error of errors) {
    for (const graph of candidateGraphs(graphs, error)) attributed.get(graph)?.push(error);
  }
  return attributed;
}

/**
 * A lookup over analyzed graphs, never by container name. It names a container only when
 * exactly one graph owns the error (its `containerId` matches, or its node is inside that
 * graph's config range). Being the only container of the file is not enough: a wrong name
 * in a CI report is worse than none.
 */
export function containerLookupOf(graphs: readonly DependencyGraph[]): ContainerLookup {
  return (error) => {
    const owners = owningGraphs(graphs, error);
    return owners.length === 1 && owners[0] ? ownerOf(owners[0]) : undefined;
  };
}

/**
 * A lookup bound to the graph an error is displayed under. It names that graph only when it
 * owns the error (same rules as `containerLookupOf`), so listing an unowned error there stamps nothing.
 */
export function containerLookupFor(graph: DependencyGraph): ContainerLookup {
  const own = containerLookupOf([graph]);
  return (error) => {
    if (error.containerId !== undefined && error.containerId !== containerKeyOf(graph)) return undefined;
    return own(error);
  };
}

/** The stable code of an error. A duplicate that carries no code is `NEO_DUPLICATE_PROVIDER`. */
export function stableCodeOf(error: AnalysisError): DiagnosticCode | undefined {
  if (error.code) return error.code;
  return error.type === 'duplicate' ? 'NEO_DUPLICATE_PROVIDER' : undefined;
}

/** The severity of an error. An absent severity is an error. */
export function stableSeverityOf(error: AnalysisError): 'error' | 'warning' {
  return error.severity ?? 'error';
}

/**
 * Turns an analysis error into the diagnostic CLI JSON, LSP and devtools share.
 * The message is copied, never parsed: code and severity come from the fields.
 * With a `lookup`, the owning container is named, its source file given, and `containerId`
 * is filled when the analyzer left it out (constructor-level misses leave it out on purpose).
 */
export function toStableDiagnostic(error: AnalysisError, lookup?: ContainerLookup): StableDiagnostic {
  const { line, character } = error.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
  const code = stableCodeOf(error);
  const tokenText = error.context?.tokenText;
  const chain = error.context?.chain;
  const owner = lookup?.(error);
  const containerId = error.containerId ?? owner?.containerKey;
  return {
    ...(code !== undefined ? { code } : {}),
    severity: stableSeverityOf(error),
    message: error.message,
    file: error.sourceFile.fileName,
    line: line + 1,
    column: character + 1,
    type: error.type,
    ...(containerId !== undefined ? { containerId } : {}),
    ...(owner?.containerName !== undefined ? { containerName: owner.containerName } : {}),
    ...(owner !== undefined && owner.sourceFile !== '' ? { containerFile: owner.sourceFile } : {}),
    ...(tokenText !== undefined ? { token: getSimpleName(tokenText) } : {}),
    ...(chain !== undefined ? { chain: [...chain] } : {}),
  };
}
