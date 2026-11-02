import { createUnplugin } from 'unplugin';
import * as ts from 'typescript';
import { textCallsResolve, type ValidationMode } from '@djodjonx/neosyringe-core/analyzer';
import { resolveDebugFlag, resolveTestOverridesFlag } from '@djodjonx/neosyringe-core/generator';
import { usageErrorsAtBuildEnd } from './buildEndUsages';
import { callsCanReachNeoSyringe, hasNeoSyringeMarkers } from './markerUtils';
import { createDevtoolsMiddleware } from './devtools';
import { moduleExtension, programFileName, runCompilationSession, shouldTransformId, type SessionState } from './session';

/** Options accepted by every bundler entry point (`.vite()`, `.rollup()`, `.webpack()`, `.esbuild()`). */
export interface NeoSyringePluginOptions {
  /**
   * Whether generated containers embed `_graph`/`_dependencyGraph` debug data.
   * Defaults to `true` outside production. Forced to `false` whenever
   * `process.env.NODE_ENV === 'production'`, with no way to override that —
   * see resolveDebugFlag in @djodjonx/neosyringe-core.
   */
  debug?: boolean;
  /**
   * When true, serves a graph visualization at /__neosyringe/ on the Vite dev-server.
   * Only active during development (Vite serve mode). Has no effect in production builds
   * or with non-Vite bundlers.
   */
  devtools?: boolean;
  /**
   * tsconfig to compile with. Resolved from the working directory.
   * When omitted, the nearest tsconfig.json is used.
   */
  project?: string;
  /**
   * Drives the buildEnd usage check only.
   * `strict` reports an unknown NeoSyringe receiver as an error.
   * `compatible` reports that same case as a warning and does not fail the build.
   * Defaults to `strict`.
   * The transform-time Analyzer in session.ts stays strict.
   */
  validation?: ValidationMode;
  /**
   * Enables container.override() / clearOverrides() in the generated container.
   * Defaults to false. Refused when NODE_ENV is production.
   * The flag is fixed at build time; generated code does not read process.
   */
  testOverrides?: boolean;
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
export const neoSyringePlugin = createUnplugin((options: NeoSyringePluginOptions | undefined = {}) => {
  // Per-build registries — scoped to the factory instance, safe for parallel builds
  const emitDebugHelpers = resolveDebugFlag(options.debug);
  const testOverrides = resolveTestOverridesFlag(options.testOverrides);
  const project = options.project || undefined;
  const state: SessionState = {
    registeredTokens: new Set(),
    usedTokens: new Map(),
    generatedContainerVars: new Set(),
    devtoolsGraphs: new Map(),
    cachedSources: new Map(),
  };
  let serving = false;
  const devtoolsActive = (): boolean =>
    serving && options.devtools === true && process.env.NODE_ENV !== 'production';
  const forgetDevtoolsFile = (id: string): void => {
    const key = programFileName(id);
    for (const [graphKey, graph] of state.devtoolsGraphs) {
      if ((graph.sourceFileName ?? '').replace(/\\/g, '/') === key) state.devtoolsGraphs.delete(graphKey);
    }
  };
  // session.ts createProgram keeps only the last transformed root. buildEnd needs every file.
  const sourceTexts = new Map<string, string>();

  return {
    name: 'neosyringe-plugin',

    /**
     * Enforce 'pre' to run before esbuild transforms TypeScript.
     */
    enforce: 'pre' as const,

    transformInclude(id) {
      return shouldTransformId(id);
    },

    transform(code, id) {
      const extension = moduleExtension(id);
      if (extension === '.mts' || extension === '.cts') {
        if (callsCanReachNeoSyringe(code, programFileName(id), {})) {
          throw new Error(`[NeoSyringe] ${extension} is not supported. Supported extensions: .ts, .tsx.`);
        }
        return undefined;
      }
      if (extension !== '.ts' && extension !== '.tsx') return undefined;
      if (devtoolsActive()) forgetDevtoolsFile(id);
      if (hasNeoSyringeMarkers(code) || textCallsResolve(code)) {
        sourceTexts.set(programFileName(id), code);
      }
      if (!hasNeoSyringeMarkers(code)) return;

      // Missing tsconfig is an error only when a call can reach a marker.
      if (!project && !state.resolved && !ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json')) {
        const probe: ts.CompilerOptions = {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          target: ts.ScriptTarget.ES2020,
        };
        if (!callsCanReachNeoSyringe(code, programFileName(id), probe)) return undefined;
      }

      const output = runCompilationSession({
        code,
        id,
        project,
        cwd: process.cwd(),
        emitDebugHelpers,
        testOverrides,
        devtools: devtoolsActive(),
        state,
        errorPrefix: '[neosyringe-plugin]',
      });
      if (output.code === code && output.map == null) return undefined;
      return output;
    },

    /**
     * Re-check resolve / resolveAll against each call's container once every file is known.
     */
    buildEnd() {
      let errors: string[] = [];
      let warnings: string[] = [];
      try {
        const report = usageErrorsAtBuildEnd(sourceTexts, state, options?.validation ?? 'strict');
        errors = report.errors;
        warnings = report.warnings;
      } finally {
        state.registeredTokens.clear();
        state.usedTokens.clear();
        state.generatedContainerVars.clear();
        sourceTexts.clear();
      }

      const host = this as { warn?: (message: string) => void } | undefined;
      for (const warning of warnings) {
        if (typeof host?.warn === 'function') host.warn(warning);
        else console.warn(warning);
      }

      if (errors.length > 0) {
        throw new Error(
          `\n${'='.repeat(60)}\n` +
          `NEO-SYRINGE: ${errors.length} unregistered token(s) found!\n` +
          `${'='.repeat(60)}\n\n` +
          errors.join('\n\n') +
          `\n\n${'='.repeat(60)}\n`
        );
      }
    },

    watchChange(id, change) {
      if (change.event === 'delete') forgetDevtoolsFile(id);
    },

    vite: {
      configureServer(server) {
        if (process.env.NODE_ENV === 'production') return;
        if (options.devtools !== true) return;
        serving = true;
        const middleware = createDevtoolsMiddleware(() => [...state.devtoolsGraphs.values()]);
        server.middlewares.use(middleware);
        // eslint-disable-next-line no-console
        console.log('[NeoSyringe] Devtools available at /__neosyringe/');
      },
    },
  };
});
