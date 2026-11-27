import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { DependencyGraph, DependencyNode } from '@djodjonx/neosyringe-core/analyzer';
import { SnapshotCache } from './invalidation';
import type { SessionState } from './session';

export function readAnalysisCounters(state: SessionState): {
  filesParsed: number;
  graphsBuilt: number;
} {
  return {
    filesParsed: state.filesParsed,
    graphsBuilt: state.graphsBuilt,
  };
}

export function noteFileParsed(state: SessionState): void {
  state.filesParsed += 1;
}

export function noteGraphsBuilt(state: SessionState, count: number): void {
  state.graphsBuilt += count;
}

export function noteAnalysisBuilt(state: SessionState): void {
  state.analysesBuilt = (state.analysesBuilt ?? 0) + 1;
}

/** Containers an analysis collected. A transform pays for the containers its file imports, not for the project. */
export function noteContainersAnalysed(state: SessionState, count: number): void {
  state.containersAnalysed = (state.containersAnalysed ?? 0) + count;
}

/** Canonical path. A missing file keeps its parent real path plus its own name. */
export function canonicalPath(file: string): string {
  const abs = path.resolve(file);
  try {
    return realpathSync(abs).replace(/\\/g, '/');
  } catch {
    try {
      const parent = realpathSync(path.dirname(abs)).replace(/\\/g, '/');
      return `${parent}/${path.basename(abs)}`;
    } catch {
      return abs.replace(/\\/g, '/');
    }
  }
}

/**
 * Text of the tsconfig plus every file `extends` makes TypeScript read.
 * The root file is separated from the chain so a chain-only edit is visible.
 * `readDirectory` stays empty: the analysis program is built from the entry, and `include` is not an input.
 */
export function configChainTexts(configPath: string): string {
  const root = path.resolve(configPath);
  const reads: { file: string; text: string }[] = [];
  const readFile = (file: string): string | undefined => {
    const text = ts.sys.readFile(file);
    reads.push({ file: path.resolve(file), text: text ?? '' });
    return text;
  };
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile,
  };
  const read = ts.readConfigFile(root, readFile);
  if (!read.error) {
    ts.parseJsonConfigFileContent(read.config, host, path.dirname(root), undefined, root);
  }
  const rootText = reads.find((row) => row.file === root)?.text ?? '';
  const extended = reads
    .filter((row) => row.file !== root)
    .map((row) => `${row.file}\0${row.text}`)
    .join('\0\0');
  return `${root}\0${rootText}\0${extended}`;
}

function cloneNode(node: DependencyNode): DependencyNode {
  return {
    ...node,
    service: { ...node.service },
    dependencies: [...(node.dependencies ?? [])],
    optionalDependencies: node.optionalDependencies ? new Set(node.optionalDependencies) : undefined,
  };
}

/** Copy a graph before attachRewrites writes the rewrites of a provider or a useValue into it. */
export function cloneGraph(graph: DependencyGraph): DependencyGraph {
  const nodes = new Map<string, DependencyNode>();
  for (const [id, node] of graph.nodes) nodes.set(id, cloneNode(node));
  let multiNodes: Map<string, DependencyNode[]> | undefined;
  if (graph.multiNodes) {
    multiNodes = new Map();
    for (const [id, list] of graph.multiNodes) multiNodes.set(id, list.map(cloneNode));
  }
  return {
    ...graph,
    nodes,
    multiNodes,
    roots: [...(graph.roots ?? [])],
    publicRoots: graph.publicRoots ? [...graph.publicRoots] : undefined,
    publicMultiRoots: graph.publicMultiRoots ? [...graph.publicMultiRoots] : undefined,
    eagerRoots: graph.eagerRoots ? [...graph.eagerRoots] : undefined,
    expectedExternalTokens: graph.expectedExternalTokens ? new Set(graph.expectedExternalTokens) : undefined,
    parentProvidedTokens: graph.parentProvidedTokens ? new Set(graph.parentProvidedTokens) : undefined,
    parentResolvableTokens: graph.parentResolvableTokens ? new Set(graph.parentResolvableTokens) : undefined,
    borrowedRegistrations: graph.borrowedRegistrations?.map((item) => ({ ...item })),
  };
}

/**
 * A content graph cache was slower on the first build than the same work without it, so no graph
 * is kept by text. A host program keeps one clean copy for the other files of that same Program.
 * A plugin transform (`scope`) reads the analysis Program of one file (`ProjectSession.scoped`): the
 * containers of the files that file imports are analysed once for that Program and kept in a cache that dies
 * with it. Only the last file is kept, so a build of N files holds one analysis, not N.
 *
 * The graphs `build` returns belong to the analysis snapshot of their Program, which every
 * analyzer on that Program shares. A transform writes into the graphs it gets (attachRewrites),
 * so every path returns copies and never the snapshot's own objects.
 */
export function graphsForProgram(
  state: SessionState,
  build: () => DependencyGraph[],
  hostProgram: ts.Program | undefined,
  scope?: { program: ts.Program; file: string },
): DependencyGraph[] {
  if (scope && !hostProgram) {
    const cache = state.snapshotCache ?? new SnapshotCache<DependencyGraph[]>();
    state.snapshotCache = cache;
    cache.begin(scope.program);
    const analysed = cache.getOrCompute('graphs', () => {
      noteAnalysisBuilt(state);
      const graphs = build();
      noteContainersAnalysed(state, graphs.length);
      return graphs;
    });
    const own = analysed.filter((graph) => (graph.sourceFileName ?? scope.file).replace(/\\/g, '/') === scope.file);
    noteGraphsBuilt(state, own.length);
    return own.map(cloneGraph);
  }
  noteAnalysisBuilt(state);
  const fresh = build();
  noteContainersAnalysed(state, fresh.length);
  noteGraphsBuilt(state, fresh.length);
  if (!hostProgram) {
    state.graphs = undefined;
    state.graphProgram = undefined;
    return fresh.map(cloneGraph);
  }
  const clean = fresh.map(cloneGraph);
  state.graphs = clean;
  state.graphProgram = hostProgram;
  return clean.map(cloneGraph);
}

/** Drops the last graphs. Identity keys stay until the file is deleted or the session closes. */
export function releaseGraphCache(state: SessionState): void {
  state.graphs = undefined;
  state.graphProgram = undefined;
  state.snapshotCache?.clear();
}
