import * as ts from 'typescript';
import { Analyzer, type AnalysisError, type ValidationMode } from '@djodjonx/neosyringe-core/analyzer';
import { ProjectSession } from './projectSession';
import { liveSession, type SessionState } from './session';

export interface BuildEndUsageReport {
  errors: string[];
  warnings: string[];
  /** The analysis errors behind `errors` and `warnings`, as the other consumers see them. */
  analysisErrors: AnalysisError[];
}

interface LocatedUsage {
  file: string;
  line: number;
  character: number;
  text: string;
}

/**
 * Re-check resolve / resolveAll / resolveMany once every transformed file is known.
 * Warnings stay out of the build failure. The three usage codes are read from
 * `error.code`, not from the message text.
 */
export function usageErrorsAtBuildEnd(
  sourceTexts: Map<string, string>,
  state: SessionState,
  validation: ValidationMode,
  environment?: string,
): BuildEndUsageReport {
  const used = usageProgram(sourceTexts, state, environment);
  if (!used) return { errors: [], warnings: [], analysisErrors: [] };
  try {
    return usageReport(used.program, sourceTexts, validation);
  } finally {
    used.transient?.close();
  }
}

function usageReport(program: ts.Program, sourceTexts: Map<string, string>, validation: ValidationMode): BuildEndUsageReport {
  const analyzer = new Analyzer(program, { validation });
  const errors: LocatedUsage[] = [];
  const warnings: LocatedUsage[] = [];
  const analysisErrors: AnalysisError[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const normalized = sourceFile.fileName.replace(/\\/g, '/');
    if (!sourceTexts.has(normalized) && !sourceTexts.has(sourceFile.fileName)) continue;
    const result = analyzer.extractForFile(sourceFile.fileName);
    for (const error of result.errors) {
      const position = sourceFile.getLineAndCharacterOfPosition(error.node.getStart(sourceFile));
      const located: LocatedUsage = {
        file: sourceFile.fileName,
        line: position.line,
        character: position.character,
        text: `${error.message} at ${sourceFile.fileName}:${position.line + 1}:${position.character + 1}`,
      };
      if (isResolutionUsageError(error)) {
        errors.push(located);
        analysisErrors.push(error);
      } else if (error.severity === 'warning' && error.code === 'NEO_UNKNOWN_CONTAINER') {
        warnings.push(located);
        analysisErrors.push(error);
      }
    }
  }
  sortLocated(errors);
  sortLocated(warnings);
  return { errors: errors.map((item) => item.text), warnings: warnings.map((item) => item.text), analysisErrors };
}

function sortLocated(items: LocatedUsage[]): void {
  items.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.character - right.character
    || left.text.localeCompare(right.text),
  );
}

/** A resolve / resolveAll / resolveMany call the checker refuses. These are reported once every file is known, not per file. */
export function isResolutionUsageError(error: AnalysisError): boolean {
  if (error.severity === 'warning') return false;
  if (error.code === 'NEO_ROOT_NOT_EXPORTED') return true;
  if (error.code === 'NEO_UNKNOWN_CONTAINER' || error.code === 'NEO_MULTI_REQUIRES_RESOLVE_ALL') {
    return true;
  }
  // Constructor misses share NEO_MISSING_PROVIDER and do not name a container.
  return error.code === 'NEO_MISSING_PROVIDER' && error.containerId !== undefined;
}

/**
 * The Program the usage check reads. A plugin that transformed files has a project session for the environment:
 * its snapshot is the Program the transforms analysed, every root and every overlay, and no second one is built.
 * It is the same Program only when every usage file is already held by the session: a file the session does not
 * hold (a file with only a `resolve(` call, which no transform analysed) is added as a root and the session builds
 * a new, incremental Program for it. Without
 * a session (a usage file with no marker file, or a caller that holds only the texts) a short-lived session
 * is built from the texts, never `ts.createProgram` on a host of its own.
 */
function usageProgram(
  sourceTexts: Map<string, string>,
  state: SessionState,
  environment: string | undefined,
): { program: ts.Program; transient: ProjectSession | undefined } | undefined {
  if (sourceTexts.size === 0) return undefined;
  const session = liveSession(state, environment);
  if (session) {
    for (const file of sourceTexts.keys()) session.addRoot(file);
    return { program: session.snapshot(), transient: undefined };
  }
  const options = {
    ...(state.resolved?.options ?? state.previousProgram?.getCompilerOptions() ?? {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
    }),
  };
  const transient = new ProjectSession(ts.sys.getCurrentDirectory(), [], options, { declarationStore: state.declarationSources });
  for (const [file, text] of sourceTexts) {
    transient.update(file, text);
    transient.addRoot(file);
  }
  return { program: transient.snapshot(), transient };
}
