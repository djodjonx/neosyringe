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
 * ```
 */
import * as ts from 'typescript';
import { resolve, relative } from 'node:path';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';

function parseArgs(argv: string[]): { project: string | undefined } {
  let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--project' || argv[i] === '-p') && argv[i + 1]) {
      project = argv[i + 1];
    }
  }
  return { project };
}

/**
 * CLI entry point.
 * Reads tsconfig.json (or --project override), analyzes all containers,
 * and reports any validation errors.
 */
function main() {
  const { project: projectArg } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const tsconfigPath = projectArg
    ? resolve(cwd, projectArg)
    : ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');

  if (!tsconfigPath) {
    console.error('❌ Could not find tsconfig.json. Use --project <path> to specify one.');
    process.exit(1);
  }

  console.log(`Analyzing project: ${tsconfigPath}`);

  const { config, error: configReadError } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configReadError) {
    console.error(`❌ Could not read tsconfig: ${ts.flattenDiagnosticMessageText(configReadError.messageText, '\n')}`);
    process.exit(1);
  }

  const { options, fileNames, errors: parseErrors } = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    cwd
  );

  if (parseErrors.length > 0) {
    console.error('❌ TypeScript config errors:');
    parseErrors.forEach(e => console.error(`   ${ts.flattenDiagnosticMessageText(e.messageText, '\n')}`));
    process.exit(1);
  }

  const program = ts.createProgram(fileNames, options);
  const analyzer = new Analyzer(program);

  try {
    console.log('🔍 Validating all dependency containers...');
    const errors = analyzer.extractAllErrors();

    if (errors.length > 0) {
      console.error(`\n❌ Validation failed — ${errors.length} error(s) found:\n`);
      for (const err of errors) {
        const filePath = relative(cwd, err.sourceFile.fileName);
        const { line, character } = err.sourceFile.getLineAndCharacterOfPosition(err.node.getStart());
        console.error(`  ${filePath}:${line + 1}:${character + 1}  [${err.type}]  ${err.message}`);
      }
      console.error('');
      process.exit(1);
    }

    console.log('✅ Validation passed! No errors found.');
    process.exit(0);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`\n❌ Unexpected error: ${message}`);
    process.exit(1);
  }
}

main();
