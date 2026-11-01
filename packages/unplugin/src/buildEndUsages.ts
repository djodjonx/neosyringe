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

/**
 * Parsed lib and declaration files for every buildEnd host in this process.
 * Stamp is the file text, same rule as `state.cachedSources` in session.ts.
 * User files are never stored here.
 */
const declarationSources = new Map<string, { stamp: string; source: ts.SourceFile }>();

function defaultLibDirectory(options: ts.CompilerOptions): string {
  const libFile = ts.getDefaultLibFilePath(options).replace(/\\/g, '/');
  return libFile.slice(0, libFile.lastIndexOf('/'));
}

function reusableDeclaration(fileName: string, options: ts.CompilerOptions): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  if (normalized.endsWith('.d.ts') || normalized.endsWith('.d.mts') || normalized.endsWith('.d.cts')) {
    return true;
  }
  const libDir = defaultLibDirectory(options);
  return libDir.length > 0 && (normalized === libDir || normalized.startsWith(`${libDir}/`));
}

function readDeclarationText(fileName: string): string | undefined {
  try {
    return ts.sys.readFile(fileName);
  } catch {
    return undefined;
  }
}

/**
 * Lib and other declaration files only.
 * A path that is in sourceTexts must not reach this function: those SourceFiles
 * are parsed from the text the plugin recorded, never from this cache.
 */
function cachedDeclaration(
  fileName: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  state: SessionState,
): ts.SourceFile | undefined {
  const sourceText = readDeclarationText(fileName);
  if (!sourceText) return undefined;
  const cached = declarationSources.get(fileName);
  if (cached !== undefined && cached.stamp === sourceText) return cached.source;
  const fromSession = state.cachedSources.get(fileName);
  if (fromSession !== undefined && fromSession.stamp === sourceText) {
    declarationSources.set(fileName, fromSession);
    return fromSession.source;
  }
  const created = ts.createSourceFile(fileName, sourceText, languageVersion, true);
  declarationSources.set(fileName, { stamp: sourceText, source: created });
  return created;
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
    // Never reuse a cached SourceFile for a path in sourceTexts.
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    if (!reusableDeclaration(fileName, options)) {
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    return cachedDeclaration(fileName, languageVersion, state);
  };
  host.fileExists = (fileName) => textFor(fileName) !== undefined || originalFileExists(fileName);
  host.readFile = (fileName) => textFor(fileName) ?? originalReadFile(fileName);
  return ts.createProgram([...sourceTexts.keys()], options, host);
}
