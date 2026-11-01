import * as ts from 'typescript';
import { Analyzer, type AnalysisError, type ValidationMode } from '@djodjonx/neosyringe-core/analyzer';
import type { SessionState } from './session';

export interface BuildEndUsageReport {
  errors: string[];
  warnings: string[];
}

interface LocatedUsage {
  file: string;
  line: number;
  character: number;
  text: string;
}

/**
 * Re-check resolve / resolveAll once every transformed file is known.
 * Warnings stay out of the build failure. The three usage codes are read from
 * `error.code`, not from the message text.
 */
export function usageErrorsAtBuildEnd(
  sourceTexts: Map<string, string>,
  state: SessionState,
  validation: ValidationMode,
): BuildEndUsageReport {
  const program = programFromSources(sourceTexts, state);
  if (!program) return { errors: [], warnings: [] };
  const analyzer = new Analyzer(program, { validation });
  const errors: LocatedUsage[] = [];
  const warnings: LocatedUsage[] = [];
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
      if (isResolutionUsageError(error)) errors.push(located);
      else if (error.severity === 'warning' && error.code === 'NEO_UNKNOWN_CONTAINER') warnings.push(located);
    }
  }
  sortLocated(errors);
  sortLocated(warnings);
  return { errors: errors.map((item) => item.text), warnings: warnings.map((item) => item.text) };
}

function sortLocated(items: LocatedUsage[]): void {
  items.sort((left, right) =>
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.character - right.character
    || left.text.localeCompare(right.text),
  );
}

function isResolutionUsageError(error: AnalysisError): boolean {
  if (error.severity === 'warning') return false;
  if (error.code === 'NEO_UNKNOWN_CONTAINER' || error.code === 'NEO_MULTI_REQUIRES_RESOLVE_ALL') {
    return true;
  }
  // Constructor misses share NEO_MISSING_PROVIDER and do not name a container.
  return error.code === 'NEO_MISSING_PROVIDER' && error.containerId !== undefined;
}

function programFromSources(sourceTexts: Map<string, string>, state: SessionState): ts.Program | undefined {
  if (sourceTexts.size === 0) return undefined;
  const options = {
    ...(state.resolved?.options ?? state.previousProgram?.getCompilerOptions() ?? {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2020,
    }),
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const textFor = (fileName: string) => sourceTexts.get(fileName) ?? sourceTexts.get(fileName.replace(/\\/g, '/'));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textFor(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => textFor(fileName) !== undefined || originalFileExists(fileName);
  host.readFile = (fileName) => textFor(fileName) ?? originalReadFile(fileName);
  return ts.createProgram([...sourceTexts.keys()], options, host);
}
