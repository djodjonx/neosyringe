import * as ts from 'typescript';
import { Analyzer, DuplicateRegistrationError, TypeMismatchError, type AnalysisErrorType } from '../../core/src/analyzer/index';
import { GraphValidator } from '../../core/src/generator/index';
import { LSPLogger } from './logger';

/**
 * Maps error types to diagnostic codes.
 */
function getErrorCode(type: AnalysisErrorType): number {
  switch (type) {
    case 'duplicate':
      return 9998;
    case 'type-mismatch':
      return 9997;
    case 'cycle':
      return 9996;
    case 'missing':
      return 9995;
    default:
      return 9999;
  }
}

/**
 * Initializes the TypeScript Language Service Plugin.
 */
function init(modules: { typescript: typeof import('typescript') }) {
  const ts = modules.typescript;

  function create(info: ts.server.PluginCreateInfo) {
    const logger = new LSPLogger(info.project?.projectService?.logger);

    const proxy: ts.LanguageService = Object.create(null);

    for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
      const x = info.languageService[k];
      // @ts-expect-error - dynamic proxy
      proxy[k] = (...args: Array<unknown>) => x.apply(info.languageService, args);
    }

    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = info.languageService.getSemanticDiagnostics(fileName);


      try {
        const program = info.languageService.getProgram();
        if (!program) return prior;

        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) return prior;

        const text = sourceFile.getText();
        const hasBuilderConfig = text.includes('defineBuilderConfig');
        const hasPartialConfig = text.includes('definePartialConfig');

        if (!hasBuilderConfig && !hasPartialConfig) return prior;

        logger.startGroup(`Analysis of ${fileName}`);
        logger.info(`Found defineBuilderConfig: ${hasBuilderConfig}, definePartialConfig: ${hasPartialConfig}`);

        const analyzer = new Analyzer(program);

        try {
          const result = analyzer.extractForFile(fileName);
          logger.info(`Extracted ${result.configs.size} config(s), ${result.errors.length} error(s)`);

          // Add errors as diagnostics
          for (const error of result.errors) {
            // Get the node's sourceFile to check if it matches
            const nodeSourceFile = error.node.getSourceFile();

            let start: number;
            let length: number;

            // If the node's sourceFile matches our file, use its position
            // Otherwise, the node is from an imported file and we can't use its position
            if (nodeSourceFile && nodeSourceFile.fileName === fileName) {
              start = error.node.getStart();
              length = error.node.getEnd() - start;
            } else {
              // Node is from a different file (e.g., imported symbol)
              // Try to find the token text in the error context
              const tokenText = error.context?.tokenText;
              if (tokenText && sourceFile) {
                const text = sourceFile.getText();
                const idx = text.indexOf(tokenText);
                if (idx >= 0) {
                  start = idx;
                  length = tokenText.length;
                } else {
                  // Fallback: use position 0
                  start = 0;
                  length = 1;
                }
              } else {
                start = 0;
                length = 1;
              }
              logger.warn(`Node from different file, using fallback position`);
            }

            prior.push({
              file: error.sourceFile,
              start,
              length,
              messageText: `[NeoSyringe] ${error.message}`,
              category: ts.DiagnosticCategory.Error,
              code: getErrorCode(error.type),
            });
          }

          // Also run legacy graph validation for cycles, missing bindings, and type mismatches
          // NOTE: Duplicate errors are handled by extractForFile above, so we skip them here
          if (hasBuilderConfig) {
            const graph = analyzer.extract();

            // Process legacy graph errors (type mismatches detected during extraction)
            // Skip duplicate errors as they are handled by the new modular validation
            if (graph.errors && graph.errors.length > 0) {
              for (const error of graph.errors) {
                // Skip duplicate errors - handled by extractForFile
                if (error.type === 'duplicate') continue;

                // Only add errors from the current file
                if (error.sourceFile.fileName !== fileName) continue;

                const start = error.node.getStart();
                const length = error.node.getEnd() - start;

                prior.push({
                  file: error.sourceFile,
                  start,
                  length,
                  messageText: `[NeoSyringe] ${error.message}`,
                  category: ts.DiagnosticCategory.Error,
                  code: getErrorCode(error.type),
                });
              }
            }

            // Run graph validator for cycles and missing bindings
            // Use validateAll() to get ALL errors, not just the first one
            const validator = new GraphValidator();
            const validationResult = validator.validateAll(graph);

            for (const validationError of validationResult.errors) {
              // Only add errors from the current file
              if (validationError.sourceFile.fileName !== fileName) continue;

              const start = validationError.node.getStart();
              const length = validationError.node.getEnd() - start;

              // Map validation error type to diagnostic code
              let code = 9999;
              if (validationError.type === 'missing') code = 9995;
              else if (validationError.type === 'duplicate') code = 9998;
              else if (validationError.type === 'cycle') code = 9996;

              prior.push({
                file: validationError.sourceFile,
                start,
                length,
                messageText: `[NeoSyringe] ${validationError.message}`,
                category: ts.DiagnosticCategory.Error,
                code,
              });

              logger.verbose(`Graph validation: ${validationError.type} on ${validationError.tokenId}`);
            }
          }
        } catch (e: unknown) {
          // Fallback for unexpected errors during extraction
          if (e instanceof DuplicateRegistrationError) {
            prior.push({
              file: e.sourceFile,
              start: e.node.getStart(e.sourceFile),
              length: e.node.getEnd() - e.node.getStart(e.sourceFile),
              messageText: `[NeoSyringe] ${e.message}`,
              category: ts.DiagnosticCategory.Error,
              code: 9998,
            });
          } else if (e instanceof TypeMismatchError) {
            prior.push({
              file: e.sourceFile,
              start: e.node.getStart(e.sourceFile),
              length: e.node.getEnd() - e.node.getStart(e.sourceFile),
              messageText: `[NeoSyringe] ${e.message}`,
              category: ts.DiagnosticCategory.Error,
              code: 9997,
            });
          } else if (e instanceof Error) {
            logger.error(`Analyzer exception: ${e.message}`);
          }
        }
      } catch (e: unknown) {
        logger.error(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        logger.endGroup();
      }

      return prior;
    };

    return proxy;
  }

  return { create };
}

export default init;
