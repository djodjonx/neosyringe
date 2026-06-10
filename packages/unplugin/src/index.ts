import { createUnplugin } from 'unplugin';
import * as ts from 'typescript';
import * as path from 'path';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { Generator } from '@djodjonx/neosyringe-core/generator';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { transformUseInterfaceCalls, type UsedTokenEntry } from './useInterfaceTransform';
import { hasNeoSyringeMarkers } from './markerUtils';

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
      if (!hasNeoSyringeMarkers(code)) return;

      const options = getCompilerOptions();

      // Handle files containing container definitions
      if (code.includes('defineBuilderConfig')) {
        // Create a custom compilerHost that serves the current file's code
        // (otherwise createProgram can't read test code that doesn't exist on disk)
        const compilerHost: ts.CompilerHost = {
          getSourceFile: (fileName) => {
            if (fileName === id) {
              return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
            }
            try {
              const sourceText = ts.sys.readFile(fileName);
              return sourceText ? ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true) : undefined;
            } catch {
              return undefined;
            }
          },
          getDefaultLibFileName: (opts) => ts.getDefaultLibFileName(opts),
          writeFile: () => {},
          getCurrentDirectory: () => process.cwd(),
          getDirectories: (path) => ts.sys.getDirectories(path),
          fileExists: (fileName) => fileName === id || ts.sys.fileExists(fileName),
          readFile: (fileName) => fileName === id ? code : ts.sys.readFile(fileName),
          getCanonicalFileName: (fileName) => fileName,
          useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
          getNewLine: () => '\n',
        };

        const program = ts.createProgram([id], options, compilerHost);
        const analyzer = new Analyzer(program);

        // extractAll() returns one graph per defineBuilderConfig call (parents included).
        // Graphs from imported files are used for token registration only.
        const allGraphs = analyzer.extractAll();

        // Check for analysis errors (duplicates, type mismatches) across all graphs
        for (const graph of allGraphs) {
          if (graph.errors && graph.errors.length > 0) {
            const messages = graph.errors.map(e => `[neosyringe-plugin] ${e.message}`).join('\n');
            const buildError = new Error(messages) as Error & { file?: string };
            buildError.name = graph.errors[0].type === 'duplicate' ? 'DuplicateRegistrationError' : 'TypeMismatchError';
            buildError.file = id;
            throw buildError;
          }
        }

        // Register tokens from ALL graphs (local + multi + parent-provided for legacy containers)
        for (const graph of allGraphs) {
          for (const tokenId of graph.nodes.keys()) registeredTokens.add(tokenId);
          if (graph.multiNodes) {
            for (const tokenId of graph.multiNodes.keys()) registeredTokens.add(tokenId);
          }
          // parentProvidedTokens: necessary for legacy containers (declareContainerTokens)
          // that have no defineBuilderConfig of their own. NeoSyringe parent tokens are
          // covered by their own graph above, so this is redundant-but-harmless for them.
          if (graph.parentProvidedTokens) {
            for (const tokenId of graph.parentProvidedTokens) registeredTokens.add(tokenId);
          }
        }

        // Normalize the current file path to forward slashes.
        // Webpack passes this.resource with backslashes on Windows while TypeScript
        // always uses forward slashes internally — without this, no container would
        // be generated on Windows (filter below would never match).
        const normalizedId = id.replace(/\\/g, '/');

        // Generate and collect replacements for graphs in THIS file only
        // (imported-file graphs are excluded — they are processed when their own file
        //  is transformed).
        const thisFileGraphs = allGraphs.filter(
          g => g.sourceFileName === normalizedId &&
               g.defineBuilderConfigStart !== undefined &&
               g.defineBuilderConfigEnd !== undefined &&
               g.variableStatementStart !== undefined
        );

        if (thisFileGraphs.length > 0) {
          // Validate each graph independently
          const validator = new GraphValidator();
          for (const graph of thisFileGraphs) {
            const validationResult = validator.validateAll(graph);
            if (!validationResult.valid) {
              const messages = validationResult.errors.map(e => e.message).join('\n  ');
              const buildError = new Error(`[neosyringe-plugin]\n  ${messages}`) as Error & { file?: string };
              buildError.file = id;
              throw buildError;
            }
          }

          // Build replacements: sort descending by variableStatementStart (right-to-left)
          // so earlier offsets remain valid as we splice.
          const replacements = [...thisFileGraphs].sort(
            (a, b) => b.variableStatementStart! - a.variableStatementStart!
          );

          let result = code;
          for (const graph of replacements) {
            const generator = new Generator(graph, true);
            const containerClass = generator.generate();
            const instantiation = generator.generateInstantiation();
            // Slice positions are from the CURRENT result, but since we process
            // right-to-left, content to the left has not yet been modified.
            const varDecl = result.slice(graph.variableStatementStart!, graph.defineBuilderConfigStart!);
            const replacement = containerClass + '\n' + varDecl + instantiation;

            result =
              result.slice(0, graph.variableStatementStart!) +
              replacement +
              result.slice(graph.defineBuilderConfigEnd!);
          }

          // Transform any remaining useInterface<T>() call sites (injection sites)
          const finalCode = transformUseInterfaceCalls(result, id, options, usedTokens);
          return finalCode ?? result;
        }
      }

      // 2. Transform useInterface<T>() calls to tokenId strings (for non-container files)
      // Collect used tokens for validation at build end
      return transformUseInterfaceCalls(code, id, options, usedTokens);
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
