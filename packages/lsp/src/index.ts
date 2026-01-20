import * as ts from 'typescript';
import { Analyzer, DuplicateRegistrationError, TypeMismatchError } from '../../core/src/analyzer/index';
import { GraphValidator } from '../../core/src/generator/index';

/**
 * Initializes the TypeScript Language Service Plugin.
 *
 * This plugin wraps the standard TypeScript Language Service to provide
 * additional diagnostics for NeoSyringe usage (e.g., circular dependencies).
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
     * Intercepts semantic diagnostics to add NeoSyringe validation errors.
     * @param fileName - The file being analyzed.
     */
    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = info.languageService.getSemanticDiagnostics(fileName);

      // Debug log helper
      const log = (msg: string) => {
        if (info.project?.projectService?.logger) {
          info.project.projectService.logger.info(`[NeoSyringe LSP] ${msg}`);
        }
      };

      // Debug log
      if (fileName.includes('container')) {
        log(`Checking file: ${fileName}`);
      }

      try {
        const program = info.languageService.getProgram();
        if (!program) {
          if (fileName.includes('container')) {
            log(`No program available`);
          }
          return prior;
        }

        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) {
          if (fileName.includes('container')) {
            log(`No source file`);
          }
          return prior;
        }

        // Only run analysis if the file contains container configuration
        const text = sourceFile.getText();
        if (!text.includes('defineBuilderConfig')) {
          if (fileName.includes('container')) {
            log(`No defineBuilderConfig found in file`);
          }
          return prior;
        }

        log(`Running analysis on: ${fileName}`);

        const analyzer = new Analyzer(program);

        try {
          const graph = analyzer.extract();

          log(`Graph extracted with ${graph.nodes.size} nodes`);

          // Process analysis errors (duplicates, type mismatches)
          if (graph.errors && graph.errors.length > 0) {
            log(`Found ${graph.errors.length} analysis error(s)`);

            for (const error of graph.errors) {
              const start = error.node.getStart(error.sourceFile);
              const end = error.node.getEnd();
              const length = end - start;

              const code = error.type === 'duplicate' ? 9998 : 9997;

              prior.push({
                file: error.sourceFile,
                start: start,
                length: length,
                messageText: `[NeoSyringe] ${error.message}`,
                category: ts.DiagnosticCategory.Error,
                code: code,
              });
            }
          }

          // Validate graph (circular dependencies, missing bindings)
          const validator = new GraphValidator();
          try {
              validator.validate(graph);
              log(`Validation passed`);
          } catch (e: unknown) {
              if (e instanceof Error) {
                  // Catch all validation errors (Cycle, Missing)
                  const msg = e.message;

                  log(`Validation error: ${msg}`);

                  // Determine category. Most are errors.
                  prior.push({
                      file: sourceFile,
                      start: 0,
                      length: 10,
                      messageText: `[NeoSyringe] ${msg}`,
                      category: ts.DiagnosticCategory.Error,
                      code: 9999,
                  });
              }
          }
        } catch (e: unknown) {
          // Fallback for unexpected errors during extraction
          if (e instanceof DuplicateRegistrationError) {
              log(`Duplicate registration detected (fallback): ${e.message}`);

              const start = e.node.getStart(e.sourceFile);
              const end = e.node.getEnd();
              const length = end - start;

              prior.push({
                  file: e.sourceFile,
                  start: start,
                  length: length,
                  messageText: `[NeoSyringe] ${e.message}`,
                  category: ts.DiagnosticCategory.Error,
                  code: 9998,
              });
          } else if (e instanceof TypeMismatchError) {
              log(`Type mismatch detected (fallback): ${e.message}`);

              const start = e.node.getStart(e.sourceFile);
              const end = e.node.getEnd();
              const length = end - start;

              prior.push({
                  file: e.sourceFile,
                  start: start,
                  length: length,
                  messageText: `[NeoSyringe] ${e.message}`,
                  category: ts.DiagnosticCategory.Error,
                  code: 9997,
              });
          } else if (e instanceof Error) {
              log(`Analyzer exception: ${e.message}`);

              prior.push({
                    file: sourceFile,
                    start: 0,
                    length: 10,
                    messageText: `[NeoSyringe] ${e.message}`,
                    category: ts.DiagnosticCategory.Error,
                    code: 9996,
              });
          }
        }
      } catch (e: unknown) {
        // Catch any unexpected errors at the top level
        log(`Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
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
