import type * as ts from 'typescript';
import {
  stableCodeOf,
  stableSeverityOf,
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
 */
export function toTsDiagnostic(
  ts: typeof import('typescript'),
  error: AnalysisError,
  sourceFile: ts.SourceFile,
): ts.Diagnostic {
  const start = error.node.getStart(sourceFile);
  return {
    file: sourceFile,
    start,
    length: error.node.getEnd() - start,
    messageText: `[NeoSyringe] ${withStableCode(error)}`,
    category: stableSeverityOf(error) === 'warning' ? ts.DiagnosticCategory.Warning : ts.DiagnosticCategory.Error,
    code: getErrorCode(error.type),
  };
}
