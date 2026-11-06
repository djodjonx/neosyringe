import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { DependencyGraph, DependencyNode } from '@djodjonx/neosyringe-core/analyzer';
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

/** Copy a graph before collectEmbeddings writes factorySource or valueSource. */
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
    parentProvidedTokens: graph.parentProvidedTokens ? new Set(graph.parentProvidedTokens) : undefined,
    parentResolvableTokens: graph.parentResolvableTokens ? new Set(graph.parentResolvableTokens) : undefined,
    borrowedRegistrations: graph.borrowedRegistrations?.map((item) => ({ ...item })),
  };
}

/**
 * Analyses on every call. A content graph cache was slower on the first build
 * than the same work without it, so a plugin transform keeps nothing.
 * A host program keeps one clean copy for the other files of that same Program.
 */
export function graphsForProgram(
  state: SessionState,
  build: () => DependencyGraph[],
  hostProgram: ts.Program | undefined,
): DependencyGraph[] {
  const fresh = build();
  noteGraphsBuilt(state, fresh.length);
  if (!hostProgram) {
    state.graphs = undefined;
    state.graphProgram = undefined;
    return fresh;
  }
  const clean = fresh.map(cloneGraph);
  state.graphs = clean;
  state.graphProgram = hostProgram;
  return clean.map(cloneGraph);
}

/** Drops the last graphs. The session does not keep a map of older ones. */
export function releaseGraphCache(state: SessionState): void {
  state.graphs = undefined;
  state.graphProgram = undefined;
}
