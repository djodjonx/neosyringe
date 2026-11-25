import type * as ts from 'typescript';
import type { DependencyGraph, AnalysisResult, AnalysisError, ValidationMode } from './types';
import { snapshotFor, type ProjectSnapshot } from './snapshot';

export {
  DuplicateRegistrationError,
  TypeMismatchError,
  UnsupportedContainerShapeError,
} from './errors/registrationErrors';

/**
 * Analyzes TypeScript source code to extract the dependency injection graph.
 *
 * One analysis serves every question about a program. `ConfigCollector.collect` is the only
 * discovery of builders and partials; graphs, diagnostics and resolve-call checks are all read
 * from that one collection, held in a snapshot that every `Analyzer` on the same immutable
 * `ts.Program` (with the same validation mode and project root) shares.
 *
 * - `extractAll()` and `extract()` build `DependencyGraph`s from the collection (see graphAdapter.ts).
 * - `extractAllErrors()` and `extractForFile()` return the diagnostics of the same snapshot; a file is
 *   validated at most once, whichever way it is asked for.
 *
 * A new `ts.Program` has a new snapshot: nothing of an older AST is reused.
 *
 * @example
 * ```typescript
 * const program = TSContext.ts.createProgram(['src/container.ts'], compilerOptions);
 * const analyzer = new Analyzer(program);
 *
 * // One graph per container, for CLI/build
 * const graphs = analyzer.extractAll();
 *
 * // Diagnostics of one file, for the IDE
 * const result = analyzer.extractForFile('src/container.ts');
 * if (!result.errors.length) {
 *   console.log('No errors found!');
 * }
 * ```
 */
export class Analyzer {
  private program: ts.Program;
  private validation: ValidationMode;

  constructor(program: ts.Program, options?: { validation?: ValidationMode }) {
    this.program = program;
    this.validation = options?.validation ?? 'strict';
  }

  /** The analysis of this program, shared with every other analyzer on it. */
  private snapshot(): ProjectSnapshot {
    return snapshotFor(this.program, this.validation);
  }

  /**
   * Extracts one merged dependency graph from the program's source files.
   *
   * Every builder that is not used as a parent gets folded into the one graph; a partial that no
   * config extends keeps its own errors, listed in `graph.errors`. Parents and extended partials
   * are skipped by configuration identity, never by variable name.
   *
   * @returns A `DependencyGraph` containing all registered services and their dependencies.
   * @see {@link extractAll} for one graph per builder
   * @see {@link extractAllErrors} for batch error extraction
   */
  public extract(): DependencyGraph {
    return this.snapshot().merged();
  }

  /**
   * Extracts one independent DependencyGraph per defineBuilderConfig call found
   * across all source files in the program.
   *
   * Unlike extract(), this method does NOT skip parent containers. Every config
   * receives its own graph, its own code-generation positions, and independent
   * dependency resolution. The plugin uses this to generate code for every
   * container in a file, regardless of whether it is referenced as a parent.
   *
   * graph.sourceFileName identifies which source file each graph belongs to,
   * allowing the plugin to generate only the graphs for the file being processed
   * while still registering tokens from all graphs (including imported containers).
   *
   * The graphs belong to the program's shared snapshot: two analyzers on one program return the
   * same objects. A caller that writes into a graph copies it first.
   *
   * @returns One DependencyGraph per defineBuilderConfig in the program.
   */
  public extractAll(): DependencyGraph[] {
    return [...this.snapshot().graphs()];
  }

  /**
   * Returns the diagnostics of every file of the program, resolve calls included.
   *
   * Reads the same snapshot as the graphs and the IDE: every container configuration is validated
   * with full semantic checks (duplicates, type mismatches, missing dependencies, cycles), and a
   * file with no container still has its resolve calls checked.
   *
   * @returns All analysis errors found across the entire program
   * @see {@link extractForFile} for single-file analysis
   */
  public extractAllErrors(): AnalysisError[] {
    return [...this.snapshot().diagnostics()];
  }

  /**
   * Entry point for LSP - the diagnostics of a specific file, from the shared snapshot.
   *
   * The snapshot is built once (collection), then validates each file at most once.
   * Runs full `CompositeValidator` (duplicates, types, missing deps, cycles).
   *
   * @param fileName - The file to analyze
   * @returns Analysis result with errors for this file only
   * @see {@link extractAllErrors} for batch analysis
   */
  public extractForFile(fileName: string): AnalysisResult {
    const snapshot = this.snapshot();
    return { configs: snapshot.configs(), errors: [...snapshot.diagnosticsOfFile(fileName)] };
  }
}
