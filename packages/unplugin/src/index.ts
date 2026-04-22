import { createUnplugin } from 'unplugin';
import * as ts from 'typescript';
import * as path from 'path';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { Generator } from '@djodjonx/neosyringe-core/generator';
import { TSContext } from '../../core/src/TSContext';
import { transformUseInterfaceCalls, type UsedTokenEntry } from './useInterfaceTransform';

/**
 * NeoSyringe build plugin for Vite, Rollup, Webpack, and other bundlers.
 *
 * Two transformations:
 * 1. Replaces `useInterface<T>()` calls with their tokenId strings (all files)
 * 2. Replaces `defineBuilderConfig` with generated container code (container files)
 *
 * @example
 * ```typescript
 * // vite.config.ts
 * import { neoSyringePlugin } from '@djodjonx/neosyringe/plugin';
 *
 * export default defineConfig({
 *   plugins: [neoSyringePlugin.vite()]
 * });
 * ```
 */
export const neoSyringePlugin = createUnplugin(() => {
  // Per-build registries — scoped to the factory instance, safe for parallel builds
  const registeredTokens = new Set<string>();
  const usedTokens = new Map<string, UsedTokenEntry>();

  // Cache tsconfig parsing — tsconfig doesn't change during a build
  let compilerOptions: ts.CompilerOptions | undefined;

  function getCompilerOptions(): ts.CompilerOptions {
    if (compilerOptions) return compilerOptions;
    const configFile = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
    if (!configFile) {
      throw new Error(
        '[NeoSyringe] Could not find tsconfig.json. ' +
        'Make sure a tsconfig.json exists in your project root.'
      );
    }
    // Set the stable project root so HashUtils produces the same token IDs as the LSP plugin.
    TSContext.projectRoot = path.dirname(configFile);
    const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd()).options;
    return compilerOptions;
  }

  return {
    name: 'neosyringe-plugin',

    /**
     * Enforce 'pre' to run before esbuild transforms TypeScript.
     */
    enforce: 'pre' as const,

    transformInclude(id) {
      return id.endsWith('.ts') || id.endsWith('.tsx');
    },

    transform(code, id) {
      // Quick exit for files that don't reference NeoSyringe APIs — avoids tsconfig load
      if (!code.includes('defineBuilderConfig') && !code.includes('useInterface')) return;

      const options = getCompilerOptions();

      // 1. If file contains defineBuilderConfig, handle it specially
      if (code.includes('defineBuilderConfig')) {
        const program = ts.createProgram([id], options);
        const analyzer = new Analyzer(program);
        const graph = analyzer.extract();

        // Check for analysis errors (duplicates, type mismatches) and fail the build
        if (graph.errors && graph.errors.length > 0) {
          const error = graph.errors[0]; // Report first error
          const errorMessage = `[neosyringe-plugin] ${error.message}`;

          // Create a custom error class for better error handling
          const buildError = new Error(errorMessage) as Error & { file?: string };
          buildError.name = error.type === 'duplicate' ? 'DuplicateRegistrationError' : 'TypeMismatchError';
          buildError.file = id;
          throw buildError;
        }

        if (graph.nodes.size > 0 &&
            graph.defineBuilderConfigStart !== undefined &&
            graph.defineBuilderConfigEnd !== undefined &&
            graph.variableStatementStart !== undefined) {

          // Register all tokens from this container for validation
          for (const tokenId of graph.nodes.keys()) {
            registeredTokens.add(tokenId);
          }

          // Step 1: Validate graph — report all errors before generating
          const validator = new GraphValidator();
          const validationResult = validator.validateAll(graph);
          if (!validationResult.valid) {
            const messages = validationResult.errors.map(e => e.message).join('\n  ');
            const buildError = new Error(`[neosyringe-plugin]\n  ${messages}`) as Error & { file?: string };
            buildError.file = id;
            throw buildError;
          }

          const generator = new Generator(graph, true);
          const containerClass = generator.generate();
          const instantiation = generator.generateInstantiation();

          // Step 2: Build code with container replacement (using ORIGINAL positions)
          const codeBeforeStatement = code.slice(0, graph.variableStatementStart);
          const codeAfterDefineBuilder = code.slice(graph.defineBuilderConfigEnd);
          const variableDeclaration = code.slice(graph.variableStatementStart, graph.defineBuilderConfigStart);

          const codeWithContainer = codeBeforeStatement +
                 containerClass + '\n' +
                 variableDeclaration +
                 instantiation +
                 codeAfterDefineBuilder;

          // Step 3: Transform useInterface calls in the final code
          // Don't collect used tokens here since tokens are defined in this file
          const finalCode = transformUseInterfaceCalls(codeWithContainer, id, options);

          return finalCode || codeWithContainer;
        }
      }

      // 2. Transform useInterface<T>() calls to tokenId strings (for non-container files)
      // Collect used tokens for validation at build end
      return transformUseInterfaceCalls(code, id, options, undefined, usedTokens);
    },

    /**
     * Validate that all used tokens are registered in containers.
     * This runs at the end of the build to ensure all files have been processed.
     */
    buildEnd() {
      const errors: string[] = [];

      for (const [tokenId, usage] of usedTokens) {
        if (!registeredTokens.has(tokenId)) {
          errors.push(
            `[NeoSyringe] Unregistered token: useInterface<${usage.interfaceName}>() at ${usage.file}:${usage.line}:${usage.column}\n` +
            `  Token "${tokenId}" is not registered in any container.\n` +
            `  Add it to your defineBuilderConfig injections.`
          );
        }
      }

      if (errors.length > 0) {
        registeredTokens.clear();
        usedTokens.clear();

        throw new Error(
          `\n${'='.repeat(60)}\n` +
          `NEO-SYRINGE: ${errors.length} unregistered token(s) found!\n` +
          `${'='.repeat(60)}\n\n` +
          errors.join('\n\n') +
          `\n\n${'='.repeat(60)}\n`
        );
      }

      registeredTokens.clear();
      usedTokens.clear();
    },
  };
});
