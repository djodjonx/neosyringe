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
 * ```
 */
import * as ts from 'typescript';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Analyzer, resolveProjectConfig } from '@djodjonx/neosyringe-core/analyzer';
import { parseArgs, buildJsonReport } from './report';
import { exportGraphHtml, exportMermaid } from './graphExport';
import { emitTokensManifest } from './tokensManifest';

/**
 * CLI entry point.
 * Reads tsconfig.json (or --project override), analyzes all containers,
 * and reports any validation errors.
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  const { project: projectArg, json, graph, mermaid } = args;
  const cwd = process.cwd();

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
      console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: message }));
    } else {
      console.error(`❌ ${message}`);
    }
    process.exit(1);
  }

  if (!json) console.log(`Analyzing project: ${tsconfigPath}`);

  if (parseErrors.length > 0) {
    const messages = parseErrors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    if (json) {
      console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: messages.join('\n') }));
    } else {
      console.error('❌ TypeScript config errors:');
      messages.forEach(m => console.error(`   ${m}`));
    }
    process.exit(1);
  }

  const program = ts.createProgram(fileNames, options);
  const analyzer = new Analyzer(program);

  try {
    if (!json) console.log('🔍 Validating all dependency containers...');
    const errors = analyzer.extractAllErrors();

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
        if (!json) console.log(`tokens manifest written to: ${written}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (json) {
          console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: message }));
        } else {
          console.error(`❌ ${message}`);
        }
        process.exit(1);
      }
    };

    // Graph export — runs independently of validation output
    if (graph !== false || mermaid) {
      const allGraphs = analyzer.extractAll();
      if (graph !== false) {
        const filePath = exportGraphHtml(allGraphs, graph, cwd);
        if (!json) console.log(`📊 Graph written to: ${filePath}`);
      }
      if (mermaid) {
        writeManifest();
        console.log(exportMermaid(allGraphs));
        process.exit(0);
      }
    }

    if (json) {
      writeManifest();
      console.log(JSON.stringify(buildJsonReport(errors, cwd)));
      process.exit(errors.length > 0 ? 1 : 0);
    }

    if (errors.length > 0) {
      console.error(`\n❌ Validation failed — ${errors.length} error(s) found:\n`);
      for (const err of errors) {
        const report = buildJsonReport([err], cwd).errors[0];
        console.error(`  ${report.file}:${report.line}:${report.column}  [${report.type}]  ${report.message}`);
      }
      console.error('');
      process.exit(1);
    }

    writeManifest();
    console.log('✅ Validation passed! No errors found.');
    process.exit(0);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: message }));
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
