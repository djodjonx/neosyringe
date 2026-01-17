import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';

/**
 * Initializes the TypeScript Language Service Plugin.
 *
 * This plugin wraps the standard TypeScript Language Service to provide
 * additional diagnostics for Neo-Syringe usage (e.g., circular dependencies).
 *
 * @param modules - The typescript module passed by the tsserver.
 * @returns An object containing the `create` factory.
 */
function init(modules: { typescript: typeof import('typescript') }) {
  const ts = modules.typescript;

  /**
   * Creates the proxy language service.
   * @param info - Plugin configuration and context.
   */
  function create(info: ts.server.PluginCreateInfo) {
    const proxy: ts.LanguageService = Object.create(null);

    // Forward all methods
    for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
      const x = info.languageService[k];
      // @ts-expect-error - dynamic proxy
      proxy[k] = (...args: Array<unknown>) => x.apply(info.languageService, args);
    }

    /**
     * Intercepts semantic diagnostics to add Neo-Syringe validation errors.
     * @param fileName - The file being analyzed.
     */
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = info.languageService.getSemanticDiagnostics(fileName);

      // Debug log helper
      const log = (msg: string) => {
        if (info.project?.projectService?.logger) {
          info.project.projectService.logger.info(`[Neo-Syringe LSP] ${msg}`);
        }
      };

      // Debug log
      if (fileName.includes('container.ts')) {
        log(`Checking file: ${fileName}`);
      }

      try {
        const program = info.languageService.getProgram();
        if (!program) {
          if (fileName.includes('container.ts')) {
            log(`No program available`);
          }
          return prior;
        }

        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) {
          if (fileName.includes('container.ts')) {
            log(`No source file`);
          }
          return prior;
        }

        // Only run analysis if the file contains container configuration
        const text = sourceFile.getText();
        if (!text.includes('defineBuilderConfig')) {
          if (fileName.includes('container.ts')) {
            log(`No defineBuilderConfig found in file`);
          }
          return prior;
        }

        log(`Running analysis on: ${fileName}`);

        const analyzer = new Analyzer(program);
        const graph = analyzer.extract();

        log(`Graph extracted with ${graph.nodes.size} nodes`);

        const validator = new GraphValidator();
        try {
            validator.validate(graph);
            log(`Validation passed`);
        } catch (e: unknown) {
            if (e instanceof Error) {
                // Catch all validation errors (Cycle, Missing, Duplicate)
                const msg = e.message;

                log(`Validation error: ${msg}`);

                // Determine category. Most are errors.
                prior.push({
                    file: sourceFile,
                    start: 0,
                    length: 10,
                    messageText: `[Neo-Syringe] ${msg}`,
                    category: ts.DiagnosticCategory.Error,
                    code: 9999,
                });
            }
        }

      } catch (e: unknown) {
          // Catch Analyzer errors (e.g. Duplicates thrown during extraction)
          if (e instanceof Error) {
              log(`Analyzer exception: ${e.message}`);

              if (e.message.includes('Duplicate')) {
                  const program = info.languageService.getProgram();
                  const file = program?.getSourceFile(fileName);
                  if (file) {
                      log(`Adding duplicate diagnostic`);
                      prior.push({
                            file: file,
                            start: 0,
                            length: 10,
                            messageText: `[Neo-Syringe] ${e.message}`,
                            category: ts.DiagnosticCategory.Error,
                            code: 9998,
                        });
                  }
              }
          }
      }

      return prior;
    };

    return proxy;
  }

  return { create };
}

// TypeScript LSP plugins require CommonJS export.
// tsdown converts `export default` to `module.exports = init` for CJS output.
export default init;
