import { createUnplugin } from 'unplugin';
import * as ts from 'typescript';
import { Analyzer, generateTokenId } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { Generator } from '@djodjonx/neosyringe-core/generator';

/**
 * Registry of tokens that are registered in container files.
 * Used to validate useInterface<T>() calls in other files.
 */
const registeredTokens = new Set<string>();

/**
 * Registry of tokens that are used (resolved) in non-container files.
 * Used to validate that all used tokens are registered.
 */
const usedTokens = new Map<string, { file: string; line: number; column: number; interfaceName: string }>();

/**
 * Transforms useInterface<T>() calls into their tokenId string values.
 * This runs on ALL TypeScript files, not just container files.
 *
 * @param excludeRange - Optional range to exclude from transformation (used for defineBuilderConfig content)
 * @param collectUsedTokens - If true, collects used tokens for later validation
 */
function transformUseInterfaceCalls(
  code: string,
  id: string,
  compilerOptions: ts.CompilerOptions,
  excludeRange?: { start: number; end: number },
  collectUsedTokens: boolean = false
): string | null {
  if (!code.includes('useInterface')) return null;

  // Create a virtual source file from the code string (not from disk)
  const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

  // Create a custom compiler host that returns our in-memory source file
  const compilerHost = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = compilerHost.getSourceFile;
  compilerHost.getSourceFile = (fileName, languageVersion) => {
    if (fileName === id) {
      return sourceFile;
    }
    return originalGetSourceFile(fileName, languageVersion);
  };

  const program = ts.createProgram([id], compilerOptions, compilerHost);
  const checker = program.getTypeChecker();
  const replacements: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node) {
    // Look for useInterface<T>() calls
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useInterface' &&
        node.typeArguments &&
        node.typeArguments.length > 0) {

      const nodeStart = node.getStart();
      const nodeEnd = node.getEnd();

      // Skip if inside exclude range
      if (excludeRange && nodeStart >= excludeRange.start && nodeEnd <= excludeRange.end) {
        ts.forEachChild(node, visit);
        return;
      }

      const typeArg = node.typeArguments[0];
      const type = checker.getTypeFromTypeNode(typeArg);
      const symbol = type.getSymbol();

      if (symbol) {
        // Generate tokenId: InterfaceName_hash
        const declarations = symbol.getDeclarations();
        let tokenId: string;

        if (declarations && declarations.length > 0) {
          const declSourceFile = declarations[0].getSourceFile();
          tokenId = generateTokenId(symbol, declSourceFile);
        } else {
          tokenId = symbol.getName();
        }

        replacements.push({
          start: nodeStart,
          end: nodeEnd,
          text: `"${tokenId}"`
        });

        // Collect used tokens for validation at build end
        if (collectUsedTokens && !usedTokens.has(tokenId)) {
          const line = sourceFile.getLineAndCharacterOfPosition(nodeStart);
          usedTokens.set(tokenId, {
            file: id,
            line: line.line + 1,
            column: line.character + 1,
            interfaceName: symbol.getName()
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length === 0) return null;

  // Apply replacements in reverse order to preserve positions
  let result = code;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }

  return result;
}

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
      const configFile = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
      if (!configFile) return;

      const { config } = ts.readConfigFile(configFile, ts.sys.readFile);
      const { options: compilerOptions } = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd());

      // 1. If file contains defineBuilderConfig, handle it specially
      if (code.includes('defineBuilderConfig')) {
        const program = ts.createProgram([id], compilerOptions);
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

          // Step 1: Generate container code
          const validator = new GraphValidator();
          validator.validate(graph);

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
          const finalCode = transformUseInterfaceCalls(codeWithContainer, id, compilerOptions);

          return finalCode || codeWithContainer;
        }
      }

      // 2. Transform useInterface<T>() calls to tokenId strings (for non-container files)
      // Collect used tokens for validation at build end
      return transformUseInterfaceCalls(code, id, compilerOptions, undefined, true);
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
        // Clear registries for next build
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

      // Clear registries for next build
      registeredTokens.clear();
      usedTokens.clear();
    },
  };
});
