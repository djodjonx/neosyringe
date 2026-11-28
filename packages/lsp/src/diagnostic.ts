import type * as ts from 'typescript';
import {
  chainLineOf,
  fixLineOf,
  stableCodeOf,
  stableSeverityOf,
  toActionableDiagnostic,
  type AnalysisError,
  type AnalysisErrorType,
} from '@djodjonx/neosyringe-core/analyzer';

const enum NeoSyringeErrorCode {
  Unsupported = 9994,
  Missing = 9995,
  Cycle = 9996,
  TypeMismatch = 9997,
  Duplicate = 9998,
  Unknown = 9999,
}

const ERROR_CODE_MAP: Record<AnalysisErrorType, NeoSyringeErrorCode> = {
  missing: NeoSyringeErrorCode.Missing,
  cycle: NeoSyringeErrorCode.Cycle,
  'type-mismatch': NeoSyringeErrorCode.TypeMismatch,
  duplicate: NeoSyringeErrorCode.Duplicate,
  unsupported: NeoSyringeErrorCode.Unsupported,
};

function getErrorCode(type: AnalysisErrorType | string): number {
  return ERROR_CODE_MAP[type as AnalysisErrorType] ?? NeoSyringeErrorCode.Unknown;
}

/** Prefixes the stable NEO_ code unless the message already starts with it. */
function withStableCode(error: AnalysisError): string {
  const code = stableCodeOf(error);
  if (code === undefined || error.message.startsWith(code)) return error.message;
  return `${code}: ${error.message}`;
}

/**
 * Converts an analysis error into a TypeScript diagnostic.
 * `ts.Diagnostic.code` is a number, so it keeps the 9994-9999 family.
 * The stable NEO_ code travels in the message. Severity is never changed.
 * The dependency chain and the fix of the shared `ActionableDiagnostic` are the related information of the diagnostic,
 * as the same two lines the CLI prints.
 */
export function toTsDiagnostic(
  ts: typeof import('typescript'),
  error: AnalysisError,
  sourceFile: ts.SourceFile,
): ts.Diagnostic {
  const start = error.node.getStart(sourceFile);
  const length = error.node.getEnd() - start;
  const code = getErrorCode(error.type);
  const actionable = toActionableDiagnostic(error);
  const relatedInformation = [chainLineOf(actionable), fixLineOf(actionable)].flatMap((line) => (
    line === undefined
      ? []
      : [{ file: sourceFile, start, length, messageText: line, category: ts.DiagnosticCategory.Message, code }]
  ));
  return {
    file: sourceFile,
    start,
    length,
    messageText: `[NeoSyringe] ${withStableCode(error)}`,
    category: stableSeverityOf(error) === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error,
    code,
    ...(relatedInformation.length > 0 ? { relatedInformation } : {}),
  };
}
