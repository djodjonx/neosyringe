import type * as ts from 'typescript';
import { Analyzer, DuplicateRegistrationError, TypeMismatchError, type AnalysisErrorType } from '../../core/src/analyzer/index';
import { GraphValidator } from '../../core/src/generator/index';
import { LSPLogger } from './logger';
import { TSContext } from '../../core/src/TSContext';

const ERROR_CODES: Record<AnalysisErrorType | string, number> = {
  missing: 9995,
  cycle: 9996,
  'type-mismatch': 9997,
  duplicate: 9998,
};

function getErrorCode(type: AnalysisErrorType | string): number {
  return ERROR_CODES[type] ?? 9999;
}

function makeDiagnostic(
  ts: typeof import('typescript'),
  node: ts.Node,
  sourceFile: ts.SourceFile,
  message: string,
  type: string
): ts.Diagnostic {
  const start = node.getStart(sourceFile);
  return {
    file: sourceFile,
    start,
    length: node.getEnd() - start,
    messageText: `[NeoSyringe] ${message}`,
    category: ts.DiagnosticCategory.Error,
    code: getErrorCode(type),
  };
}

function makeDiagnosticFromPosition(
  ts: typeof import('typescript'),
  program: ts.Program,
  fileName: string,
  line: number,
  character: number,
  message: string,
  type: string
): ts.Diagnostic | undefined {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return undefined;
  
  const start = sourceFile.getPositionOfLineAndCharacter(line, character);
  return {
    file: sourceFile,
    start,
    length: 1,
    messageText: `[NeoSyringe] ${message}`,
    category: ts.DiagnosticCategory.Error,
    code: getErrorCode(type),
  };
}

function init(modules: { typescript: typeof import('typescript') }) {
  const ts = modules.typescript;
  TSContext.ts = ts;

  function create(info: ts.server.PluginCreateInfo) {
    const logger = new LSPLogger(info.project?.projectService?.logger);

    // Cache the Analyzer per program instance — programs change when files are modified,
    // so this avoids rebuilding the full analyzer on every keystroke.
    let cachedProgram: ts.Program | undefined;
    let cachedAnalyzer: Analyzer | undefined;

    function getAnalyzer(program: ts.Program): Analyzer {
      if (program !== cachedProgram) {
        cachedProgram = program;
        cachedAnalyzer = new Analyzer(program);
      }
      return cachedAnalyzer!;
    }

    const proxy: ts.LanguageService = Object.create(null);
    for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
      const x = info.languageService[k];
      // @ts-expect-error - dynamic proxy
      proxy[k] = (...args: Array<unknown>) => x.apply(info.languageService, args);
    }

    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = info.languageService.getSemanticDiagnostics(fileName);

      const program = info.languageService.getProgram();
      if (!program) return prior;

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) return prior;

      const text = sourceFile.getText();
      if (!text.includes('defineBuilderConfig') && !text.includes('definePartialConfig')) return prior;

      try {
        const analyzer = getAnalyzer(program);

        // Modular validation: duplicates, type mismatches, missing dependencies
        const result = analyzer.extractForFile(fileName);
        for (const error of result.errors) {
          const nodeFile = error.node.getSourceFile();
          const targetFile = nodeFile?.fileName === fileName ? nodeFile : sourceFile;
          prior.push(makeDiagnostic(ts, error.node, targetFile, error.message, error.type));
        }

        // Graph validation: constructor-level cycles (not covered by extractForFile)
        if (text.includes('defineBuilderConfig')) {
          const graph = analyzer.extract();

          for (const error of (graph.errors ?? [])) {
            if (error.type === 'duplicate') continue;
            if (error.sourceFile.fileName !== fileName) continue;
            prior.push(makeDiagnostic(ts, error.node, error.sourceFile, error.message, error.type));
          }

          // Cycles and missing deps — duplicates are already covered above
          const { errors: validationErrors } = new GraphValidator().validateAll(graph);
          for (const error of validationErrors) {
            if (error.type === 'duplicate') continue;
            if (error.sourceFile.fileName !== fileName) continue;
            prior.push(makeDiagnostic(ts, error.node, error.sourceFile, error.message, error.type));
          }
        }
      } catch (e: unknown) {
        if (e instanceof DuplicateRegistrationError || e instanceof TypeMismatchError) {
          const diagnostic = makeDiagnosticFromPosition(
            ts,
            program,
            e.fileName,
            e.line,
            e.character,
            e.message,
            e instanceof DuplicateRegistrationError ? 'duplicate' : 'type-mismatch'
          );
          if (diagnostic) prior.push(diagnostic);
        } else {
          logger.error(`NeoSyringe analysis failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return prior;
    };

    return proxy;
  }

  return { create };
}

export default init;
