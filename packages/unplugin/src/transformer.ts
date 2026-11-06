import * as ts from 'typescript';
import type { PluginConfig, ProgramTransformerExtras } from 'ts-patch';
import { resolveProjectConfig } from '@djodjonx/neosyringe-core/analyzer';
import { resolveDebugFlag, resolveTestOverridesFlag } from '@djodjonx/neosyringe-core/generator';
import { hasNeoSyringeMarkers } from './markerUtils';
import { blockingConfigMessage, rewriteEmittedOutput, runCompilationSession, type SessionFileMap, type SessionState } from './session';

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
function programWithHostTexts(
  program: ts.Program,
  options: ts.CompilerOptions,
  tsInstance: typeof ts,
): ts.Program {
  const texts = new Map<string, string>();
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) texts.set(sourceFile.fileName, sourceFile.text);
  }
  const host = tsInstance.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => texts.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => texts.get(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = texts.get(fileName);
    if (text !== undefined) return tsInstance.createSourceFile(fileName, text, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  return tsInstance.createProgram(program.getRootFileNames(), options, host);
}

export default function neoSyringeTransformer(
  program: ts.Program,
  host: ts.CompilerHost | undefined,
  config: PluginConfig,
  { ts: tsInstance }: ProgramTransformerExtras,
): ts.Program {
  const compilerOptions = program.getCompilerOptions();
  // Reads a `debug` key from the plugin's own tsconfig.json entry, e.g.
  // { "transform": "@djodjonx/neosyringe-plugin/transformer", "debug": false }.
  // Shares resolveDebugFlag with the bundler entry points (index.ts) so the
  // "forced off in production, no escape hatch" behavior is identical
  // regardless of which one a project uses.
  const emitDebugHelpers = resolveDebugFlag(config.debug);
  const testOverrides = resolveTestOverridesFlag(config.testOverrides);
  const project = typeof config.project === 'string' && config.project.length > 0 ? config.project : undefined;

  let analysisProgram = program;
  let analysisOptions = compilerOptions;
  if (project) {
    const resolved = resolveProjectConfig(process.cwd(), project);
    const messages = blockingConfigMessage(resolved.parseErrors, tsInstance);
    if (messages !== undefined) {
      throw new Error(`[neosyringe-transformer]\n  ${messages}`);
    }
    analysisOptions = resolved.options;
    analysisProgram = programWithHostTexts(program, analysisOptions, tsInstance);
  }

  const transformedSources = new Map<string, string>();
  const sessionMaps = new Map<string, SessionFileMap>();
  const state: SessionState = {
    registeredTokens: new Set(),
    usedTokens: new Map(),
    generatedContainerVars: new Set(),
    devtoolsGraphs: new Map(),
    cachedSources: new Map(),
    filesParsed: 0,
    graphsBuilt: 0,
    declarationSources: new Map(),
  };

  for (const sourceFile of analysisProgram.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!hasNeoSyringeMarkers(sourceFile.text)) continue;
    const output = runCompilationSession({
      code: sourceFile.text,
      id: sourceFile.fileName,
      project,
      cwd: process.cwd(),
      emitDebugHelpers,
      testOverrides,
      devtools: false,
      state,
      errorPrefix: '[neosyringe-transformer]',
      hostProgram: analysisProgram,
      hostSource: sourceFile,
    });
    if (output.map) {
      sessionMaps.set(sourceFile.fileName, { map: output.map, originalText: sourceFile.text });
    }
    if (output.code !== sourceFile.text) transformedSources.set(sourceFile.fileName, output.code);
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
        return sf;
      }
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };

  // Create a new program with the transformed sources; the type checker will
  // bind symbols against the transformed text.
  const rootFileNames = program.getRootFileNames();
  const created = tsInstance.createProgram(rootFileNames, compilerOptions, customHost);
  return withComposedEmit(created, sessionMaps, customHost);
}

function withComposedEmit(
  program: ts.Program,
  sessions: ReadonlyMap<string, SessionFileMap>,
  host: ts.CompilerHost,
): ts.Program {
  const emit = program.emit.bind(program);
  const composed: ts.Program['emit'] = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
    const sink: ts.WriteFileCallback = writeFile ?? ((fileName, text, writeByteOrderMark) => {
      host.writeFile(fileName, text, writeByteOrderMark);
    });
    return emit(
      targetSourceFile,
      (fileName, text, writeByteOrderMark, onError, sourceFiles, data) => {
        sink(
          fileName,
          rewriteEmittedOutput(fileName, text, sourceFiles, sessions),
          writeByteOrderMark,
          onError,
          sourceFiles,
          data,
        );
      },
      cancellationToken,
      emitOnlyDtsFiles,
      customTransformers,
    );
  };
  // Same program object: callers compare it with ===. Only emit is replaced.
  Object.assign(program, { emit: composed });
  return program;
}
