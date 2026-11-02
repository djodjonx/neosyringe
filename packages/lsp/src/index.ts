import type * as ts from 'typescript';
import { Analyzer, textCallsResolve } from '@djodjonx/neosyringe-core/analyzer';
import { toTsDiagnostic } from './diagnostic';
import { LSPLogger } from './logger';
import { TSContext } from '@djodjonx/neosyringe-core/context';

function init(modules: { typescript: typeof import('typescript') }) {
  const ts = modules.typescript;
  TSContext.ts = ts;

  function create(info: ts.server.PluginCreateInfo) {
    // Set the project root so HashUtils produces identical token IDs to the build plugin.
    const projectRoot = info.project?.getCurrentDirectory?.();
    if (projectRoot) {
      TSContext.projectRoot = projectRoot;
    }
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
      if (
        !text.includes('defineBuilderConfig')
        && !text.includes('definePartialConfig')
        && !textCallsResolve(text)
      ) return prior;

      try {
        const analyzer = getAnalyzer(program);

        // Modular validation: duplicates, type mismatches, missing dependencies, cycles
        const result = analyzer.extractForFile(fileName);
        for (const error of result.errors) {
          const nodeFile = error.node.getSourceFile();
          const targetFile = nodeFile?.fileName === fileName ? nodeFile : sourceFile;
          prior.push(toTsDiagnostic(ts, error, targetFile));
        }
      } catch (e: unknown) {
        logger.error(`NeoSyringe analysis failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return prior;
    };

    return proxy;
  }

  return { create };
}

export default init;
