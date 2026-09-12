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
import { resolve } from 'node:path';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { parseArgs, buildJsonReport } from './report';
import { exportGraphHtml, exportMermaid } from './graphExport';

/**
 * CLI entry point.
 * Reads tsconfig.json (or --project override), analyzes all containers,
 * and reports any validation errors.
 */
function main() {
  const { project: projectArg, json, graph, mermaid } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const tsconfigPath = projectArg
    ? resolve(cwd, projectArg)
    : ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');

  if (!tsconfigPath) {
    const message = 'Could not find tsconfig.json. Use --project <path> to specify one.';
    if (json) {
      console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: message }));
    } else {
      console.error(`❌ ${message}`);
    }
    process.exit(1);
  }

  if (!json) console.log(`Analyzing project: ${tsconfigPath}`);

  const { config, error: configReadError } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configReadError) {
    const message = `Could not read tsconfig: ${ts.flattenDiagnosticMessageText(configReadError.messageText, '\n')}`;
    if (json) {
      console.log(JSON.stringify({ ok: false, errorCount: 0, errors: [], fatal: message }));
    } else {
      console.error(`❌ ${message}`);
    }
    process.exit(1);
  }

  const { options, fileNames, errors: parseErrors } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    cwd
  );

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

    // Graph export — runs independently of validation output
    if (graph !== false || mermaid) {
      const allGraphs = analyzer.extractAll();
      if (graph !== false) {
        const filePath = exportGraphHtml(allGraphs, graph, cwd);
        if (!json) console.log(`📊 Graph written to: ${filePath}`);
      }
      if (mermaid) {
        console.log(exportMermaid(allGraphs));
        process.exit(0);
      }
    }

    if (json) {
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

main();
