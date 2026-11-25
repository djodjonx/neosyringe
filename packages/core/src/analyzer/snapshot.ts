import type * as ts from 'typescript';
import { TSContext } from '../TSContext';
import type { AnalysisError, ConfigCollection, ConfigGraph, DependencyGraph, ValidationMode } from './types';
import { ConfigCollector } from './collectors';
import { TokenResolver } from './resolvers';
import {
  CompositeValidator,
  CycleValidator,
  DependencyAnalyzer,
  DisposableTransientCaptureValidator,
  DuplicateValidator,
  MissingDependencyValidator,
  TypeValidator,
  type ValidationContext,
} from './validators';
import { CycleError, ErrorFormatter } from './errors';
import { TokenResolverService } from './shared';
import { graphsFromSnapshot, mergedGraphFromSnapshot } from './graphAdapter';

/** A memo that also remembers a failure, so a second read throws the same error instead of recomputing. */
class Memo<T> {
  private state: { ok: true; value: T } | { ok: false; error: unknown } | undefined;

  constructor(private readonly compute: () => T) {}

  get(): T {
    if (!this.state) {
      try {
        this.state = { ok: true, value: this.compute() };
      } catch (error: unknown) {
        this.state = { ok: false, error };
      }
    }
    if (!this.state.ok) throw this.state.error;
    return this.state.value;
  }
}

/**
 * What a compiler-dependent adapter provides, once. Every caller then reads the same snapshot.
 * `K` is the collection (configs plus what could not become one), `G` a graph, `D` a diagnostic.
 */
export interface AnalysisAdapters<P extends object, K, G, D> {
  collect(program: P): K;
  /** Files whose diagnostics make up the whole-program list, in order. */
  files(program: P, collection: K): readonly string[];
  /** Diagnostics of one file. Called at most once per file. */
  validateFile(program: P, collection: K, file: string): readonly D[];
  /** Hook to list the whole-program diagnostics (for example to drop repeats across files). */
  list(diagnostics: readonly D[]): readonly D[];
  graphs(program: P, collection: K): readonly G[];
  fileOfGraph(graph: G): string;
}

/**
 * One analysis of one immutable program. Collection, diagnostics and graphs are separate lazy
 * memos: reading the diagnostics does not build graphs, and a graph that cannot be built does not
 * hide the diagnostics. A failure is kept and thrown again on the next read.
 */
export class SnapshotAnalysis<P extends object, K, G, D> {
  private readonly collected: Memo<K>;
  private readonly graphList: Memo<readonly G[]>;
  private readonly allDiagnostics: Memo<readonly D[]>;
  private readonly perFile = new Map<string, Memo<readonly D[]>>();

  constructor(
    private readonly program: P,
    private readonly adapters: AnalysisAdapters<P, K, G, D>,
  ) {
    this.collected = new Memo(() => adapters.collect(program));
    this.graphList = new Memo(() => adapters.graphs(program, this.collected.get()));
    this.allDiagnostics = new Memo(() => {
      const collection = this.collected.get();
      const all: D[] = [];
      for (const file of adapters.files(program, collection)) all.push(...this.diagnosticsOfFile(file));
      return adapters.list(all);
    });
  }

  collection(): K {
    return this.collected.get();
  }

  graphs(): readonly G[] {
    return this.graphList.get();
  }

  diagnostics(): readonly D[] {
    return this.allDiagnostics.get();
  }

  diagnosticsOfFile(file: string): readonly D[] {
    let memo = this.perFile.get(file);
    if (!memo) {
      memo = new Memo(() => this.adapters.validateFile(this.program, this.collected.get(), file));
      this.perFile.set(file, memo);
    }
    return memo.get();
  }

  forFile(file: string): { graphs: G[]; diagnostics: readonly D[] } {
    return {
      graphs: this.graphs().filter((graph) => this.adapters.fileOfGraph(graph) === file),
      diagnostics: this.diagnosticsOfFile(file),
    };
  }
}

/** What the analyzer reads from a snapshot. */
export interface ProjectSnapshot {
  collection(): ConfigCollection;
  configs(): Map<string, ConfigGraph>;
  diagnostics(): readonly AnalysisError[];
  diagnosticsOfFile(file: string): readonly AnalysisError[];
  graphs(): readonly DependencyGraph[];
  merged(): DependencyGraph;
}

/** One diagnostic per file, registration and captured token, when errors are listed together. */
export function listedCaptures(errors: readonly AnalysisError[]): AnalysisError[] {
  const seen = new Set<string>();
  const kept: AnalysisError[] = [];
  for (const error of errors) {
    if (error.code !== 'NEO_DISPOSABLE_TRANSIENT_CAPTURED') {
      kept.push(error);
      continue;
    }
    const key = `${error.sourceFile.fileName}:${error.node.getStart()}\0${error.context?.tokenText ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(error);
  }
  return kept;
}

function createSnapshot(program: ts.Program, validation: ValidationMode): ProjectSnapshot {
  const checker = program.getTypeChecker();
  const tokens = new TokenResolverService(checker);
  const errorFormatter = new ErrorFormatter();
  const dependencyAnalyzer = new DependencyAnalyzer(checker, tokens);
  const missingDeps = new MissingDependencyValidator(errorFormatter, dependencyAnalyzer, checker, validation);
  const tokenResolver = new TokenResolver();
  const validator = new CompositeValidator([
    new DuplicateValidator(errorFormatter),
    new TypeValidator(checker, errorFormatter),
    missingDeps,
    new CycleValidator(dependencyAnalyzer),
    new DisposableTransientCaptureValidator(validation),
  ]);
  const env = { checker, tokens, validation };

  const analysis = new SnapshotAnalysis<ts.Program, ConfigCollection, DependencyGraph, AnalysisError>(program, {
    collect: () => new ConfigCollector(program, checker, tokens, validation).collectAll(),
    files: () => program.getSourceFiles().filter((file) => !file.isDeclarationFile).map((file) => file.fileName),
    validateFile: (_program, collection, fileName) => {
      const allConfigs = collection.configs;
      const errors: AnalysisError[] = [];
      const configsInFile = [...allConfigs.values()].filter((config) => config.sourceFile.fileName === fileName);
      for (const config of configsInFile) {
        const context: ValidationContext = { allConfigs };
        if (config.type === 'builder') {
          try {
            context.inheritedTokens = tokenResolver.resolveInheritedTokens(config, allConfigs);
            context.inheritedMultiTokens = tokenResolver.resolveInheritedMultiTokens(config, allConfigs);
          } catch (e) {
            if (e instanceof CycleError) {
              errors.push({
                type: 'cycle',
                message: e.message,
                node: config.node,
                sourceFile: config.sourceFile,
                context: { chain: e.chain },
              });
              continue;
            }
            throw e;
          }
        }
        // valueErrors holds type-mismatch errors produced during collection
        // (useValue+primitive, async+transient, mixed multi/non-multi)
        if (config.valueErrors) errors.push(...config.valueErrors);
        errors.push(...validator.validate(config, context));
      }
      const sourceFile = program.getSourceFile(fileName);
      if (sourceFile && !sourceFile.isDeclarationFile) {
        errors.push(...missingDeps.validateResolutionUsages(sourceFile, allConfigs));
      }
      return listedCaptures(errors);
    },
    list: (diagnostics) => listedCaptures(diagnostics),
    graphs: (_program, collection) => graphsFromSnapshot(env, collection),
    fileOfGraph: (graph) => graph.sourceFileName ?? '',
  });
  const merged = new Memo(() => mergedGraphFromSnapshot(env, analysis.collection()));

  return {
    collection: () => analysis.collection(),
    configs: () => analysis.collection().configs,
    diagnostics: () => analysis.diagnostics(),
    diagnosticsOfFile: (file) => analysis.diagnosticsOfFile(file),
    graphs: () => analysis.graphs(),
    merged: () => merged.get(),
  };
}

const snapshots = new WeakMap<ts.Program, Map<string, ProjectSnapshot>>();

/**
 * The snapshot of an immutable program. It is shared by every analyzer on that program with the same
 * validation mode and project root. Container identity depends on the root (project-relative origin),
 * so two roots never share. A new program has no snapshot: nothing of the old AST is reused.
 */
export function snapshotFor(program: ts.Program, validation: ValidationMode): ProjectSnapshot {
  let byKey = snapshots.get(program);
  if (!byKey) {
    byKey = new Map();
    snapshots.set(program, byKey);
  }
  const key = `${validation}\0${TSContext.projectRoot}`;
  let snapshot = byKey.get(key);
  if (!snapshot) {
    snapshot = createSnapshot(program, validation);
    byKey.set(key, snapshot);
  }
  return snapshot;
}
