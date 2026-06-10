import type * as ts from 'typescript';
import { TSContext } from '../TSContext';
import {
  DependencyGraph,
  AnalysisResult,
  ConfigGraph,
  AnalysisError
} from './types';
import { ConfigCollector, type IConfigCollector } from './collectors';
import { TokenResolver, type ITokenResolver } from './resolvers';
import { DependencyResolver } from './resolvers/DependencyResolver';
import { ParentContainerResolver } from './resolvers/ParentContainerResolver';
import { ConfigParser } from './parsers/ConfigParser';
import {
  CompositeValidator,
  DuplicateValidator,
  TypeValidator,
  MissingDependencyValidator,
  DependencyAnalyzer,
  CycleValidator,
  type IValidator,
  type ValidationContext
} from './validators';
import { ErrorFormatter, CycleError, type IErrorFormatter } from './errors';
import { TokenResolverService } from './shared';
import { CallExpressionUtils } from './utils';
import { ASTVisitor } from './visitors';

/**
 * Error thrown when a duplicate registration is detected.
 * Includes the position of the duplicate registration node.
 */
export class DuplicateRegistrationError extends Error {
  public readonly fileName: string;
  public readonly line: number;
  public readonly character: number;
  /** Byte offset of the end of the offending node (for diagnostic span width). */
  public readonly endOffset: number;

  constructor(
    message: string,
    node: ts.Node,
    sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'DuplicateRegistrationError';
    this.fileName = sourceFile.fileName;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.line = pos.line;
    this.character = pos.character;
    this.endOffset = node.getEnd();
  }
}

/**
 * Error thrown when a provider type is incompatible with the token type.
 * Includes the position of the registration node.
 */
export class TypeMismatchError extends Error {
  public readonly fileName: string;
  public readonly line: number;
  public readonly character: number;
  /** Byte offset of the end of the offending node (for diagnostic span width). */
  public readonly endOffset: number;

  constructor(
    message: string,
    node: ts.Node,
    sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'TypeMismatchError';
    this.fileName = sourceFile.fileName;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.line = pos.line;
    this.character = pos.character;
    this.endOffset = node.getEnd();
  }
}


/**
 * Analyzes TypeScript source code to extract the dependency injection graph.
 *
 * This class orchestrates the analysis process by coordinating specialized services:
 * - TokenResolverService: Resolves token IDs from expressions
 * - DependencyResolver: Analyzes constructor dependencies
 * - ConfigCollector: Collects container configurations
 * - Validators: Validates the dependency graph
 * - ASTVisitor: Efficiently traverses the AST
 *
 * The analyzer uses the TypeScript Compiler API to:
 * 1. Locate `defineBuilderConfig` and `definePartialConfig` calls
 * 2. Parse injection configurations
 * 3. Resolve symbols and types for services and their dependencies
 * 4. Validate the complete dependency graph
 * 5. Build a `DependencyGraph` representing the system
 *
 * ## Analysis Paths
 *
 * The analyzer exposes two APIs that serve different consumers:
 *
 * ### Legacy path — `extract()` → `DependencyGraph`
 * Used by the CLI (`@djodjonx/neosyringe-cli`) and build plugins (Vite/Webpack).
 * Scans all source files in the program, builds a full dependency graph, and
 * applies basic structural checks (cycle detection via topological sort in Generator).
 * Returns a `DependencyGraph` ready for code generation.
 *
 * ### Modular path — `extractForFile()` / `extractAllErrors()` → `AnalysisResult`
 * Used by the LSP plugin (`@djodjonx/neosyringe-lsp`).
 * Collects all configs once (cached), then validates one file at a time using
 * `CompositeValidator` (duplicate, type, missing-dependency, cycle checks).
 * Returns structured `AnalysisError[]` suitable for IDE diagnostics.
 *
 * Both paths share the TypeScript `TypeChecker` for symbol resolution, but use
 * entirely separate config-discovery pipelines (each with its own `TokenResolverService`):
 * - Legacy path uses `ASTVisitor` + `ConfigParser` directly
 * - Modular path uses `ConfigCollector` (with caching across calls to `extractForFile`)
 *
 * @example
 * ```typescript
 * const program = TSContext.ts.createProgram(['src/container.ts'], compilerOptions);
 * const analyzer = new Analyzer(program);
 *
 * // Legacy path: Extract the complete dependency graph for CLI/build
 * const graph = analyzer.extract();
 *
 * // Modular path: Analyze a specific file for LSP diagnostics
 * const result = analyzer.extractForFile('src/container.ts');
 * if (!result.errors.length) {
 *   console.log('No errors found!');
 * }
 * ```
 */
export class Analyzer {
  private program: ts.Program;
  private checker: ts.TypeChecker;

  // === SHARED SERVICES ===
  private tokenResolverService: TokenResolverService;

  constructor(program: ts.Program) {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.tokenResolverService = new TokenResolverService(this.checker);
  }

  // === LEGACY PATH ===
  // Services initialized lazily — only used by extract()

  private _legacyServices: {
    dependencyResolver: DependencyResolver;
    configParser: ConfigParser;
    parentContainerResolver: ParentContainerResolver;
    parentContainerNames: Set<string>;
  } | undefined;

  // Populated from ASTVisitor results during extract() — separate from service construction.
  private _extendsReferences: ReadonlySet<string> = new Set<string>();

  private getLegacyServices() {
    if (!this._legacyServices) {
      const configParser = new ConfigParser(this.checker, this.tokenResolverService);
      this._legacyServices = {
        dependencyResolver: new DependencyResolver(this.checker, this.tokenResolverService),
        configParser,
        parentContainerResolver: new ParentContainerResolver(
          this.checker,
          this.tokenResolverService,
          (node, graph) => this.parseBuilderConfig(node, graph)
        ),
        parentContainerNames: new Set<string>(),
      };
    }
    return this._legacyServices;
  }

  // === MODULAR PATH ===
  // Services initialized lazily — only used by extractForFile() / extractAllErrors()

  private _modularServices: {
    configCollector: IConfigCollector;
    tokenResolver: ITokenResolver;
    validator: IValidator;
    collectedConfigs: Map<string, ConfigGraph> | undefined;
    collectionError: Error | undefined;
  } | undefined;

  private getModularServices() {
    if (!this._modularServices) {
      const errorFormatter: IErrorFormatter = new ErrorFormatter();
      const dependencyAnalyzer = new DependencyAnalyzer(this.checker, this.tokenResolverService);
      this._modularServices = {
        configCollector: new ConfigCollector(this.program, this.checker),
        tokenResolver: new TokenResolver(),
        validator: new CompositeValidator([
          new DuplicateValidator(errorFormatter),
          new TypeValidator(this.checker, errorFormatter),
          new MissingDependencyValidator(errorFormatter, dependencyAnalyzer),
          new CycleValidator(dependencyAnalyzer),
        ]),
        collectedConfigs: undefined,
        collectionError: undefined,
      };
    }
    return this._modularServices;
  }

  private getCollectedConfigs(): Map<string, ConfigGraph> {
    const svc = this.getModularServices();
    if (svc.collectionError) throw svc.collectionError;
    if (!svc.collectedConfigs) {
      try {
        svc.collectedConfigs = svc.configCollector.collect();
      } catch (e) {
        if (e instanceof Error) svc.collectionError = e;
        throw e;
      }
    }
    return svc.collectedConfigs;
  }

  /**
   * Extracts the dependency graph from the program's source files.
   *
   * **Legacy path** used by CLI and build plugins.
   *
   * Scans all non-declaration source files for container configurations.
   * Each defineBuilderConfig gets its own isolated graph to avoid false positives.
   * Basic validation errors (duplicates, type mismatches) are collected in `graph.errors`.
   * Cycle detection is deferred to the `Generator`'s topological sort.
   * Missing dependencies are not caught until container runtime (via `NeoServiceNotFoundError`
   * in the generated code).
   *
   * @returns A `DependencyGraph` containing all registered services and their dependencies.
   * @see {@link extractForFile} for the modular/LSP alternative
   * @see {@link extractAllErrors} for batch error extraction
   */
  public extract(): DependencyGraph {
    const graph: DependencyGraph = {
      containerId: 'DefaultContainer', // Will be set by parseBuilderConfig
      nodes: new Map(),
      roots: [],
      errors: [], // Initialize error collection
    };

    const { parentContainerNames } = this.getLegacyServices();

    // Single pass: collect parent container names, extends refs, and config call sites
    // This replaces three separate AST traversals with one.
    const visitor = new ASTVisitor();
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      visitor.visit(sourceFile);
    }
    const visitorResults = visitor.getResults();
    for (const name of visitorResults.parentContainers) {
      parentContainerNames.add(name);
    }
    this._extendsReferences = visitorResults.extendsReferences;

    // Second pass: parse and build the dependency graph
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      this.visitNode(sourceFile, graph);
    }

    this.resolveAllDependencies(graph);
    return graph;
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
   * @returns One DependencyGraph per defineBuilderConfig in the program.
   */
  public extractAll(): DependencyGraph[] {
    const { parentContainerNames } = this.getLegacyServices();

    // Pass 1: collect metadata — parent names, extends refs, all call sites
    const visitor = new ASTVisitor();
    for (const sourceFile of this.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) continue;
      visitor.visit(sourceFile);
    }
    const visitorResults = visitor.getResults();
    for (const name of visitorResults.parentContainers) {
      parentContainerNames.add(name);
    }
    this._extendsReferences = visitorResults.extendsReferences;

    const graphs: DependencyGraph[] = [];

    // Pass 2: build one graph per builder config (parents included — no skip)
    for (const configCall of visitorResults.builderConfigs) {
      const graph: DependencyGraph = {
        containerId: 'DefaultContainer',
        nodes: new Map(),
        roots: [],
        errors: [],
      };

      const positioned = this.setGraphPositions(configCall, graph);
      if (!positioned) continue; // Skip anonymous/unrecognised patterns

      graph.defineBuilderConfigStart = configCall.getStart();
      graph.defineBuilderConfigEnd = configCall.getEnd();
      graph.sourceFileName = configCall.getSourceFile().fileName;

      this.parseBuilderConfig(configCall, graph);
      this.resolveAllDependencies(graph);

      graphs.push(graph);
    }

    return graphs;
  }


  /**
   * Analyzes all files in the program and returns all errors.
   *
   * **Modular path** used for batch validation.
   *
   * Uses the modular architecture (same as LSP) so every container
   * configuration in the program is validated with full semantic checks
   * (duplicates, type mismatches, missing dependencies, cycles).
   *
   * @returns All analysis errors found across the entire program
   * @see {@link extractForFile} for single-file analysis
   * @see {@link extract} for the legacy graph-building path
   */
  public extractAllErrors(): AnalysisError[] {
    const allConfigs = this.getCollectedConfigs();
    const errors: AnalysisError[] = [];
    const processedFiles = new Set<string>();

    for (const config of allConfigs.values()) {
      const fileName = config.sourceFile.fileName;
      if (!processedFiles.has(fileName)) {
        processedFiles.add(fileName);
        const result = this.extractForFile(fileName);
        errors.push(...result.errors);
      }
    }

    return errors;
  }

  /**
   * Entry point for LSP - analyzes a specific file.
   *
   * **Modular path** used by the LSP plugin.
   *
   * Uses the modular architecture for isolated validation. Collects all configs
   * (cached across calls), then validates only those defined in the specified file.
   * Runs full `CompositeValidator` (duplicates, types, missing deps, cycles).
   *
   * @param fileName - The file to analyze
   * @returns Analysis result with errors for this file only
   * @see {@link extractAllErrors} for batch analysis
   * @see {@link extract} for the legacy graph-building path
   */
  public extractForFile(fileName: string): AnalysisResult {
    const { tokenResolver, validator } = this.getModularServices();
    const allConfigs = this.getCollectedConfigs();
    const errors: AnalysisError[] = [];

    // Find configs defined in this file
    const configsInFile = [...allConfigs.values()]
      .filter(c => c.sourceFile.fileName === fileName);

    // Validate each config
    for (const config of configsInFile) {
      const context: ValidationContext = { allConfigs };

      // For builders, resolve inherited tokens
      if (config.type === 'builder') {
        try {
          context.inheritedTokens = tokenResolver.resolveInheritedTokens(
            config,
            allConfigs
          );
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
      if (config.valueErrors) {
        errors.push(...config.valueErrors);
      }

      errors.push(...validator.validate(config, context));
    }

    return { configs: allConfigs, errors };
  }

  /**
   * Reads the VariableStatement wrapping a defineBuilderConfig call and
   * populates the graph's position fields and export modifier.
   * Returns false if the positions could not be determined.
   */
  private setGraphPositions(node: ts.CallExpression, graph: DependencyGraph): boolean {
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
    if (TSContext.ts.isExportAssignment(parent) && parent.isExportEquals === false) {
      graph.variableExportModifier = 'export default';
      graph.variableStatementStart = parent.getStart();
      return true;
    }

    return false;
  }

  /**
   * Visits an AST node to find container calls.
   * @param node - The AST node to visit.
   * @param graph - The graph to populate.
   */
  private visitNode(node: ts.Node, graph: DependencyGraph): void {
    const { parentContainerNames } = this.getLegacyServices();
    const extendsReferences = this._extendsReferences;

    if (TSContext.ts.isCallExpression(node)) {
      if (CallExpressionUtils.isDefineBuilderConfig(node)) {
        const parent = node.parent;

        if (TSContext.ts.isVariableDeclaration(parent) && TSContext.ts.isIdentifier(parent.name)) {
          if (parentContainerNames.has(parent.name.text)) {
            // Skip - this container is used as a parent, handled by extract()'s parent resolver
            return;
          }
        }

        // Populate positions using shared helper
        this.setGraphPositions(node, graph);

        // Store the position of defineBuilderConfig call for replacement
        graph.defineBuilderConfigStart = node.getStart();
        graph.defineBuilderConfigEnd = node.getEnd();
        this.parseBuilderConfig(node, graph);

      } else if (CallExpressionUtils.isDefinePartialConfig(node)) {
        const parent = node.parent;
        if (TSContext.ts.isVariableDeclaration(parent) && TSContext.ts.isIdentifier(parent.name)) {
          const partialName = parent.name.text;
          if (!extendsReferences.has(partialName)) {
            const partialGraph: DependencyGraph = {
              containerId: partialName,
              nodes: new Map(),
              roots: [],
              errors: []
            };
            this.parseBuilderConfig(node, partialGraph);
            if (partialGraph.errors && partialGraph.errors.length > 0) {
              if (!graph.errors) graph.errors = [];
              graph.errors.push(...partialGraph.errors);
            }
          }
        }
      }
    }

    TSContext.ts.forEachChild(node, (child) => this.visitNode(child, graph));
  }

  /**
   * Parses a defineBuilderConfig or definePartialConfig call.
   * Delegates to ConfigParser service.
   */
  private parseBuilderConfig(node: ts.CallExpression, graph: DependencyGraph): void {
    const { configParser, parentContainerResolver, parentContainerNames } = this.getLegacyServices();

    configParser.parseBuilderConfig(node, graph, parentContainerNames);

    // Handle parent container token extraction
    const args = node.arguments;
    if (args.length >= 1 && TSContext.ts.isObjectLiteralExpression(args[0])) {
      const useContainerProp = args[0].properties.find(p =>
        p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === 'useContainer'
      );

      if (useContainerProp && TSContext.ts.isPropertyAssignment(useContainerProp) && TSContext.ts.isIdentifier(useContainerProp.initializer)) {
        parentContainerResolver.extractParentContainerTokens(
          useContainerProp.initializer,
          graph,
          parentContainerNames
        );
      }
    }
  }

  /**
   * Resolves dependencies for all nodes in the graph.
   *
   * Delegates to the DependencyResolver service which analyzes
   * constructor parameters and maps them to token IDs.
   *
   * @param graph - The dependency graph to process
   */
  private resolveAllDependencies(graph: DependencyGraph): void {
    const { dependencyResolver } = this.getLegacyServices();
    dependencyResolver.resolveAll(graph);

    // Resolve dependencies for multi-nodes
    if (graph.multiNodes) {
      for (const nodes of graph.multiNodes.values()) {
        for (const node of nodes) {
          dependencyResolver.resolve(node, graph);
        }
      }
    }
  }
}
