import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildRetentionReport,
  explainRetention,
  type DependencyGraph,
  type ExplainResult,
} from '@djodjonx/neosyringe-core/analyzer';

export interface ExplainRun {
  /** 0 when the token is found, 1 when it is absent. */
  exitCode: 0 | 1;
  output: string;
}

export interface ExplainRunOptions {
  /** Container key or name that narrows the answer. */
  container?: string;
  /** Print the versioned JSON report instead of text. */
  json: boolean;
  cwd: string;
}

function describe(result: ExplainResult, showRegistration: boolean): string {
  if (result.containerFound === false) return `No container matches '${result.container}'. '${result.token}' was not looked up.`;
  const where = result.containerKey !== undefined
    ? ` in container '${result.containerName ?? result.containerKey}' (${result.containerKey}, ${result.sourceFile})`
    : '';
  if (!result.found) return `'${result.token}' is not registered${where}.`;
  const which = showRegistration ? ` [registration ${result.registrationId}]` : '';
  return `'${result.token}' is kept${where}${which}: ${result.cause}\n  path: ${(result.path ?? []).join(' -> ')}`;
}

/** True when another found result of the same container shows the same token. */
function hasSeveralIn(results: ExplainResult[], result: ExplainResult): boolean {
  if (!result.found) return false;
  return results.filter(other => other.found && other.containerKey === result.containerKey).length > 1;
}

/** Answers `--explain <token>`. Pure: the caller prints `output` and exits with `exitCode`. */
export function runExplain(graphs: DependencyGraph[], token: string, options: ExplainRunOptions): ExplainRun {
  const report = explainRetention(graphs, token, { container: options.container, cwd: options.cwd });
  const exitCode = report.results.some(result => result.found) ? 0 : 1;
  const output = options.json
    ? JSON.stringify(report)
    : report.results.map(result => describe(result, hasSeveralIn(report.results, result))).join('\n');
  return { exitCode, output };
}

/** The versioned retention report as pretty JSON. */
export function renderRetentionReport(graphs: DependencyGraph[], cwd: string): string {
  return JSON.stringify(buildRetentionReport(graphs, cwd), null, 2);
}

/** Writes the retention report to `target` (relative to `cwd`). Returns the path written. */
export function writeRetentionReport(graphs: DependencyGraph[], target: string, cwd: string): string {
  const filePath = path.isAbsolute(target) ? target : path.resolve(cwd, target);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${renderRetentionReport(graphs, cwd)}\n`, 'utf8');
  return filePath;
}
