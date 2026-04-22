import * as ts from 'typescript';
import type { PluginConfig, ProgramTransformerExtras } from 'ts-patch';
import { Analyzer, HashUtils } from '@djodjonx/neosyringe-core/analyzer';
import { Generator, GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { transformUseInterfaceCalls } from './useInterfaceTransform';

/**
 * ts-patch–compatible TypeScript **Program** transformer for NeoSyringe.
 *
 * Runs as a Program transformer (transformProgram: true) so that
 * TypeScript's type checker sees the already-transformed source text.
 * This avoids symbol-binding issues that arise when returning freshly-created
 * source files from a before-transformer.
 *
 * Performs the same two transformations as the bundler plugin:
 * 1. Replaces `defineBuilderConfig(...)` with generated container code
 * 2. Replaces `useInterface<T>()` calls with their tokenId strings
 *
 * Configure in tsconfig.json (requires ts-patch):
 * ```json
 * {
 *   "compilerOptions": {
 *     "plugins": [
 *       { "transform": "@djodjonx/neosyringe-plugin/transformer", "transformProgram": true }
 *     ]
 *   }
 * }
 * ```
 */
export default function neoSyringeTransformer(
  program: ts.Program,
  host: ts.CompilerHost | undefined,
  _config: PluginConfig,
  { ts: tsInstance }: ProgramTransformerExtras,
): ts.Program {
  const compilerOptions = program.getCompilerOptions();

  // Map of fileName -> transformed source text
  const transformedSources = new Map<string, string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    const code = sourceFile.text;
    const fileName = sourceFile.fileName;

    if (!code.includes('defineBuilderConfig') && !code.includes('useInterface')) {
      continue;
    }

    let transformedCode = code;

    // --- Container transformation ---
    if (code.includes('defineBuilderConfig')) {
      // Use a per-file sub-program so the Analyzer sees only this container file.
      const fileProgram = tsInstance.createProgram([fileName], compilerOptions);
      const analyzer = new Analyzer(fileProgram);
      const graph = analyzer.extract();

      if (
        graph.nodes.size > 0 &&
        graph.defineBuilderConfigStart !== undefined &&
        graph.defineBuilderConfigEnd !== undefined &&
        graph.variableStatementStart !== undefined
      ) {
        const validator = new GraphValidator();
        const validationResult = validator.validateAll(graph);
        if (!validationResult.valid) {
          const messages = validationResult.errors.map(e => e.message).join('\n  ');
          throw new Error(`[neosyringe-transformer]\n  ${messages}`);
        }

        const generator = new Generator(graph, true);
        const containerClass = generator.generate();
        const instantiation = generator.generateInstantiation();

        const codeBeforeStatement = code.slice(0, graph.variableStatementStart);
        const codeAfterDefineBuilder = code.slice(graph.defineBuilderConfigEnd);
        const variableDeclaration = code.slice(
          graph.variableStatementStart,
          graph.defineBuilderConfigStart,
        );

        transformedCode =
          codeBeforeStatement +
          containerClass + '\n' +
          variableDeclaration +
          instantiation +
          codeAfterDefineBuilder;
      }
    }

    // --- useInterface transformation ---
    const withUseInterface = transformUseInterfaceCalls(transformedCode, fileName, compilerOptions);
    if (withUseInterface !== null) {
      transformedCode = withUseInterface;
    }

    if (transformedCode !== code) {
      transformedSources.set(fileName, transformedCode);
    }
  }

  if (transformedSources.size === 0) {
    return program;
  }

  // Build a custom compiler host that serves transformed source texts.
  // We wrap the original host (which may be an incremental host with version tracking)
  // so that source file versions are set correctly for the builder program.
  const originalGetSourceFile = host
    ? host.getSourceFile.bind(host)
    : tsInstance.createCompilerHost(compilerOptions).getSourceFile;

  const baseHost = host ?? tsInstance.createCompilerHost(compilerOptions);

  const customHost: ts.CompilerHost = {
    ...baseHost,
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      if (transformedSources.has(fileName)) {
        // Create the source file with the transformed text.
        // The version will be set by the host's wrapped getSourceFile if the base host
        // uses setGetSourceFileAsHashVersioned (incremental host does this automatically).
        // We temporarily replace the text to let the host handle version assignment.
        const transformedText = transformedSources.get(fileName)!;
        const sf = tsInstance.createSourceFile(
          fileName,
          transformedText,
          languageVersion,
          true,
        );
        // Set version as a hash of the transformed content to satisfy the builder.
        // This matches what TypeScript's createIncrementalCompilerHost does internally
        // via setGetSourceFileAsHashVersioned.
        if ((sf as any).version === undefined) {
          (sf as any).version = (baseHost as any).createHash
            ? (baseHost as any).createHash(transformedText)
            : hashString(transformedText);
        }
        return sf;
      }
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };

  // Create a new program with the transformed sources; the type checker will
  // bind symbols against the transformed text.
  const rootFileNames = program.getRootFileNames();
  return tsInstance.createProgram(rootFileNames, compilerOptions, customHost);
}

/**
 * Simple djb2 hash for version fingerprinting.
 */
function hashString(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash | 0; // Convert to 32-bit integer
  }
  return String(hash >>> 0);
}
