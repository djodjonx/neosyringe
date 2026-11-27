#!/usr/bin/env node
/**
 * NeoSyringe CLI
 *
 * Validates the dependency injection graph for a TypeScript project.
 * Detects circular dependencies, missing bindings, duplicate registrations,
 * and type mismatches — across all container configurations in the project.
 *
 * @example
 * ```bash
 * npx neosyringe-check
 * npx neosyringe-check --project ./tsconfig.build.json
 * npx neosyringe-check --json   # machine-readable output for CI
 * npx neosyringe-check --explain UserService   # why is this token kept?
 * npx neosyringe-check --retention-report retention.json
 * npx neosyringe-check doctor   # versions, tsconfig, package exports and the declared integration
 * ```
 */
import * as ts from 'typescript';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analyzer, containerLookupOf, resolveProjectConfig } from '@djodjonx/neosyringe-core/analyzer';
import { parseArgs, buildJsonReport, buildFatalReport, findUsageError, findDoctorUsageError, isDoctorCommand, CLI_USAGE } from './report';
import { renderTextReport } from './diagnostics';
import { buildDoctorReport, renderDoctorText, runDoctor } from './doctor';
import type { AnalysisError, ContainerLookup, DependencyGraph } from '@djodjonx/neosyringe-core/analyzer';
import { renderRetentionReport, runExplain, writeRetentionReport } from './explain';
import { exportGraphHtml, exportMermaid } from './graphExport';
import { emitTokensManifest } from './tokensManifest';

/**
 * Names the container that owns each error (see `containerLookupOf`). This only enriches the
 * report: when the graphs cannot be built, the errors are still reported without names.
 */
function lookupFor(errors: AnalysisError[], graphs: () => DependencyGraph[]): ContainerLookup | undefined {
  if (errors.length === 0) return undefined;
  try {
    return containerLookupOf(graphs());
  } catch {
    return undefined;
  }
}

/** `doctor`: reads the environment, never the application. Exit 1 when a check is an error, 2 on a usage error. */
function runDoctorCommand(argv: string[]): never {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(CLI_USAGE);
    process.exit(0);
  }
  const usageError = findDoctorUsageError(argv);
  if (usageError) {
    if (args.json) {
      console.log(JSON.stringify(buildFatalReport(usageError)));
    } else {
      console.error(`❌ ${usageError}\n   Run with --help for the flags.`);
    }
    process.exit(2);
  }
  const result = runDoctor({ cwd: process.cwd(), project: args.project });
  console.log(args.json ? JSON.stringify(buildDoctorReport(result)) : renderDoctorText(result));
  process.exit(result.exitCode);
}

/**
 * CLI entry point.
 * Reads tsconfig.json (or --project override), analyzes all containers,
 * and reports any validation errors.
 */
function main() {
  if (isDoctorCommand(process.argv.slice(2))) runDoctorCommand(process.argv.slice(3));
  const args = parseArgs(process.argv.slice(2));
  const { project: projectArg, json, graph, mermaid } = args;
  const cwd = process.cwd();

  if (args.help) {
    console.log(CLI_USAGE);
    process.exit(0);
  }

  const usageError = findUsageError(process.argv.slice(2), args);
  if (usageError) {
    if (json) {
      console.log(JSON.stringify(buildFatalReport(usageError)));
    } else {
      console.error(`❌ ${usageError}\n   Run with --help for the flags.`);
    }
    process.exit(2);
  }

  // `--retention-report` with no path: stdout holds the report only, so every
  // progress line goes to stderr.
  const info = args.retentionReport === true ? console.error : console.log;

  let tsconfigPath: string;
  let options: ts.CompilerOptions;
  let fileNames: string[];
  let parseErrors: readonly ts.Diagnostic[];
  try {
    const resolved = resolveProjectConfig(cwd, projectArg, 'Use --project <path>.');
    tsconfigPath = resolved.configPath;
    options = resolved.options;
    fileNames = resolved.fileNames;
    parseErrors = resolved.parseErrors;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      console.log(JSON.stringify(buildFatalReport(message)));
    } else {
      console.error(`❌ ${message}`);
    }
    process.exit(1);
  }

  if (!json) info(`Analyzing project: ${tsconfigPath}`);

  if (parseErrors.length > 0) {
    const messages = parseErrors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    if (json) {
      console.log(JSON.stringify(buildFatalReport(messages.join('\n'))));
    } else {
      console.error('❌ TypeScript config errors:');
      messages.forEach(m => console.error(`   ${m}`));
    }
    process.exit(1);
  }

  const program = ts.createProgram(fileNames, options);
  const analyzer = new Analyzer(program);

  try {
    // Explain reads the recorded retention. It does not validate.
    if (args.explain !== undefined) {
      const run = runExplain(analyzer.extractAll(), args.explain, { container: args.container, json, cwd });
      console.log(run.output);
      process.exit(run.exitCode);
    }

    if (!json) info('🔍 Validating all dependency containers...');
    const errors = analyzer.extractAllErrors();

    let cachedGraphs: DependencyGraph[] | undefined;
    const graphsOnce = (): DependencyGraph[] => (cachedGraphs ??= analyzer.extractAll());

    // The retention report never skips validation: the file is written, then the normal flow continues.
    if (args.retentionReport === true) {
      console.log(renderRetentionReport(graphsOnce(), cwd));
    } else if (args.retentionReport !== false) {
      const written = writeRetentionReport(graphsOnce(), args.retentionReport, cwd);
      if (!json) info(`retention report written to: ${written}`);
    }

    const writeManifest = (): void => {
      if (args.tokensManifest === undefined && args.contractVersion === undefined) return;
      if (errors.length > 0) return;
      try {
        const written = emitTokensManifest({
          tokensManifest: args.tokensManifest,
          contractVersion: args.contractVersion,
          project: projectArg,
          cwd,
          program,
        });
        if (!json) info(`tokens manifest written to: ${written}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
          console.log(JSON.stringify(buildFatalReport(message)));
        } else {
          console.error(`❌ ${message}`);
        }
        process.exit(1);
      }
    };

    // Graph export — runs independently of validation output
    if (graph !== false || mermaid) {
      const allGraphs = graphsOnce();
      if (graph !== false) {
        const filePath = exportGraphHtml(allGraphs, graph, cwd, errors);
        if (!json) info(`📊 Graph written to: ${filePath}`);
      }
      if (mermaid) {
        writeManifest();
        console.log(exportMermaid(allGraphs));
        process.exit(0);
      }
    }

    if (json) {
      writeManifest();
      console.log(JSON.stringify(buildJsonReport(errors, cwd, lookupFor(errors, graphsOnce))));
      process.exit(errors.length > 0 ? 1 : 0);
    }

    if (errors.length > 0) {
      console.error(`\n❌ Validation failed — ${errors.length} error(s) found:\n`);
      console.error(renderTextReport(errors, cwd, lookupFor(errors, graphsOnce)));
      console.error('');
      process.exit(1);
    }

    writeManifest();
    info('✅ Validation passed! No errors found.');
    process.exit(0);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify(buildFatalReport(message)));
    } else {
      console.error(`\n❌ Unexpected error: ${message}`);
    }
    process.exit(1);
  }
}

/** True when `entry` is this module. A missing path is compared as text. */
export function cliEntryMatches(entry: string, modulePath: string): boolean {
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return path.resolve(entry) === path.resolve(modulePath);
  }
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return cliEntryMatches(entry, fileURLToPath(import.meta.url));
}

if (isCliEntry()) {
  main();
}
