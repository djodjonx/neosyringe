import { formatDiagnostic, toActionableDiagnostic, type AnalysisError, type ContainerLookup } from '@djodjonx/neosyringe-core/analyzer';

/**
 * The text of a failed run: one `formatDiagnostic` block per error, a blank line between blocks.
 * Files are relative to `cwd`. The blocks carry the stable code, the dependency chain and the fix, as the JSON report does.
 */
export function renderTextReport(errors: readonly AnalysisError[], cwd: string, lookup?: ContainerLookup): string {
  return errors
    .map((error) => formatDiagnostic(toActionableDiagnostic(error, { root: cwd, ...(lookup !== undefined ? { lookup } : {}) })))
    .join('\n\n');
}
