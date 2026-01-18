#!/usr/bin/env node
/**
 * NeoSyringe CLI
 *
 * Validates the dependency graph for a TypeScript project.
 * Detects circular dependencies, missing bindings, and duplicate registrations.
 *
 * @example
 * ```bash
 * npx neo-syringe-check
 * ```
 */
import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';

/**
 * CLI entry point.
 * Reads tsconfig.json, analyzes the project, and validates the dependency graph.
 */
function main() {
  const cwd = process.cwd();
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');

  if (!configPath) {
    console.error('❌ Could not find tsconfig.json');
    process.exit(1);
  }

  console.log(`Analyzing project: ${configPath}`);

  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options, fileNames, errors } = ts.parseJsonConfigFileContent(config, ts.sys, cwd);

  if (errors.length > 0) {
    console.error('❌ TypeScript config errors:');
    errors.forEach(e => console.error(e.messageText));
    process.exit(1);
  }

  const program = ts.createProgram(fileNames, options);
  const analyzer = new Analyzer(program);

  try {
    console.log('🔍 Extracting dependency graph...');
    const graph = analyzer.extract();

    console.log(`   Found ${graph.nodes.size} services.`);

    console.log('🛡️  Validating graph...');
    const validator = new GraphValidator();
    validator.validate(graph);

    console.log('✅ Validation passed! No circular dependencies or missing bindings found.');
    process.exit(0);
  } catch (e: any) {
    console.error(`
❌ Validation Failed:`);
    console.error(`   ${e.message}`);
    process.exit(1);
  }
}

main();
