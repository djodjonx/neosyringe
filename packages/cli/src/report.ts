import type { AnalysisError } from '@djodjonx/neosyringe-core/analyzer';
import { relative } from 'node:path';

export interface CliArgs {
  project: string | undefined;
  json: boolean;
  /** Path to write HTML output, true for default filename, false if not requested. */
  graph: string | true | false;
  mermaid: boolean;
}

/** Parses CLI arguments. Pure and side-effect free — easy to unit test. */
export function parseArgs(argv: string[]): CliArgs {
  let project: string | undefined;
  let json = false;
  let graph: string | true | false = false;
  let mermaid = false;

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--project' || argv[i] === '-p') && argv[i + 1]) {
      project = argv[i + 1];
    }
    if (argv[i] === '--json') {
      json = true;
    }
    if (argv[i] === '--graph') {
      const next = argv[i + 1];
      graph = next && !next.startsWith('--') ? next : true;
    }
    if (argv[i] === '--mermaid') {
      mermaid = true;
    }
  }

  return { project, json, graph, mermaid };
}

export interface JsonReportError {
  file: string;
  line: number;
  column: number;
  type: string;
  message: string;
}

export interface JsonReport {
  ok: boolean;
  errorCount: number;
  errors: JsonReportError[];
}

/**
 * Builds a machine-readable report for `--json` mode, suitable for CI
 * integration (e.g. `neosyringe-check --json | jq '.errors'`).
 */
export function buildJsonReport(errors: AnalysisError[], cwd: string): JsonReport {
  return {
    ok: errors.length === 0,
    errorCount: errors.length,
    errors: errors.map(err => {
      const { line, character } = err.sourceFile.getLineAndCharacterOfPosition(err.node.getStart());
      return {
        file: relative(cwd, err.sourceFile.fileName),
        line: line + 1,
        column: character + 1,
        type: err.type,
        message: err.message,
      };
    }),
  };
}
