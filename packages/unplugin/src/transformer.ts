import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { Generator, GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { transformUseInterfaceCalls } from './useInterfaceTransform';

/**
 * ts-patch–compatible TypeScript compiler transformer for NeoSyringe.
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
 *       { "transform": "@djodjonx/neosyringe-plugin/transformer" }
 *     ]
 *   }
 * }
 * ```
 */
export default function neoSyringeTransformer(
  program: ts.Program,
): ts.TransformerFactory<ts.SourceFile> {
  const compilerOptions = program.getCompilerOptions();

  return (_context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile): ts.SourceFile => {
      const code = sourceFile.text;

      if (!code.includes('defineBuilderConfig') && !code.includes('useInterface')) {
        return sourceFile;
      }

      const fileName = sourceFile.fileName;

      // --- Container transformation ---
      if (code.includes('defineBuilderConfig')) {
        // Create a per-file program so the Analyzer sees only this container file.
        // This mirrors the unplugin approach and correctly handles multiple containers.
        const fileProgram = ts.createProgram([fileName], compilerOptions);
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

          const withContainer =
            codeBeforeStatement +
            containerClass + '\n' +
            variableDeclaration +
            instantiation +
            codeAfterDefineBuilder;

          const finalCode =
            transformUseInterfaceCalls(withContainer, fileName, compilerOptions) ?? withContainer;

          return ts.createSourceFile(
            fileName,
            finalCode,
            sourceFile.languageVersion,
            true,
            ts.ScriptKind.TS,
          );
        }
      }

      // --- useInterface-only files ---
      const transformed = transformUseInterfaceCalls(code, fileName, compilerOptions);
      if (transformed) {
        return ts.createSourceFile(
          fileName,
          transformed,
          sourceFile.languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }

      return sourceFile;
    };
  };
}
