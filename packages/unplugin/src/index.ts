import { createUnplugin, type UnpluginOptions } from 'unplugin';
import * as ts from 'typescript';
import { textCallsResolve, type AnalysisError, type ValidationMode } from '@djodjonx/neosyringe-core/analyzer';
import { resolveDebugFlag, resolveTestOverridesFlag } from '@djodjonx/neosyringe-core/generator';
import { releaseGraphCache } from './analysisCache';
import { usageErrorsAtBuildEnd } from './buildEndUsages';
import { callsCanReachNeoSyringe, hasNeoSyringeMarkers } from './markerUtils';
import { lazyOnce } from './lazy';
import {
  applyWatchChange,
  closeProjectSession,
  moduleExtension,
  normalizeModuleId,
  programFileName,
  revalidateSessions,
  runCompilationSession,
  sessionStateKey,
  shouldTransformId,
  trackSourceText,
  type SessionState,
} from './session';

/** Options accepted by every bundler entry point (`.vite()`, `.rollup()`, `.webpack()`, `.esbuild()`). */
export interface NeoSyringePluginOptions {
  /**
   * Whether generated containers embed `_graph`/`_dependencyGraph` debug data.
   * Defaults to `false`: only an explicit `true` embeds it. Forced to `false` whenever
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
  /**
   * Adds the optional production observation to every generated container: `observe(sink)` and `stateSnapshot()`, and a
   * start and an end event around each construct, initialize step and dispose. Defaults to false: the output then has no
   * observation code and reads no clock. Unlike `debug` and `testOverrides` it is allowed when NODE_ENV is production,
   * since production is what it is for. The flag is fixed at build time; generated code does not read process.
   */
  observation?: boolean;
}

/** True when the hook context says the build is a watch build (Rollup and Vite: `this.meta.watchMode`). */
function isWatchBuild(context: object | undefined): boolean {
  if (typeof context !== 'object' || context === null || !('meta' in context)) return false;
  const meta = context.meta;
  return typeof meta === 'object' && meta !== null && 'watchMode' in meta && meta.watchMode === true;
}

/** The Vite 6+ environment name of a hook context, when there is one. */
function environmentName(context: object | undefined): string | undefined {
  if (typeof context !== 'object' || context === null || !('environment' in context)) return undefined;
  const environment = context.environment;
  return typeof environment === 'object' && environment !== null && 'name' in environment && typeof environment.name === 'string'
    ? environment.name
    : undefined;
}

/**
 * The devtools module holds the HTTP middleware and, through it, the HTML renderer of `@djodjonx/neosyringe-ui`.
 * Nothing needs it before a Vite dev server serves the devtools, so it is a separate chunk loaded on the first
 * `configureServer` that asks for it.
 */
const loadDevtools = lazyOnce(() => import('./devtools'));

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
  const observation = options.observation === true;
  const project = options.project || undefined;
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
  let serving = false;
  const devtoolsActive = (): boolean =>
    serving && options.devtools === true && process.env.NODE_ENV !== 'production';
  const forgetDevtoolsFile = (id: string): void => {
    const key = programFileName(id);
    for (const [graphKey, graph] of state.devtoolsGraphs) {
      if ((graph.sourceFileName ?? '').replace(/\\/g, '/') === key) state.devtoolsGraphs.delete(graphKey);
    }
  };
  // Rollup and Vite each get their own hook object. Both call this.
  const clearCollisions = (): void => {
    state.collisions?.clear();
  };
  // The files that carry a marker or a resolve call, with their text, per bundler environment: buildEnd checks
  // these. The text of every transformed file is kept by the project session of its environment (session.ts).
  const sourceTexts = new Map<string, Map<string, string>>();
  const textsOf = (environment: string | undefined): Map<string, string> => {
    const name = environment ?? '';
    const known = sourceTexts.get(name);
    if (known) return known;
    const created = new Map<string, string>();
    sourceTexts.set(name, created);
    return created;
  };
  // A watch build keeps the usage files between builds: a changed dependency can break a file nobody touched.
  let watching = false;
  const closeSession = (declarations: 'keep' | 'free'): void => {
    closeProjectSession(state, declarations);
    sourceTexts.clear();
  };

  const plugin: UnpluginOptions = {
    name: 'neosyringe-plugin',

    /**
     * Enforce 'pre' to run before esbuild transforms TypeScript.
     */
    enforce: 'pre' as const,

    transformInclude(id) {
      return shouldTransformId(id);
    },

    buildStart() {
      if (isWatchBuild(this)) watching = true;
      // One revalidation of every file per build: the watcher events are not trusted alone.
      revalidateSessions(state);
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
      const environment = environmentName(this);
      trackSourceText(state, process.cwd(), programFileName(id), code, environment);
      // A file that stops matching leaves the check: a text kept from an earlier build of a watch would be judged.
      if (hasNeoSyringeMarkers(code) || textCallsResolve(code)) {
        textsOf(environment).set(programFileName(id), code);
      } else {
        textsOf(environment).delete(programFileName(id));
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
        observation,
        devtools: devtoolsActive(),
        state,
        errorPrefix: '[neosyringe-plugin]',
        environment,
        warn: (message) => {
          const host = this as { warn?: (message: string) => void } | undefined;
          if (typeof host?.warn === 'function') host.warn(message);
          else console.warn(message);
        },
      });
      if (output.code === code && output.map == null) return undefined;
      return output;
    },

    /**
     * Re-check resolve / resolveAll / resolveMany against each call's container once every file is known.
     */
    buildEnd() {
      let errors: string[] = [];
      let warnings: string[] = [];
      let analysisErrors: AnalysisError[] = [];
      try {
        // Each environment is checked on its own session and its own texts. The same finding is reported once.
        const seen = new Set<string>();
        for (const [name, texts] of sourceTexts) {
          const report = usageErrorsAtBuildEnd(texts, state, options?.validation ?? 'strict', name === '' ? undefined : name);
          for (const text of report.errors) if (!errors.includes(text)) errors.push(text);
          for (const text of report.warnings) if (!warnings.includes(text)) warnings.push(text);
          for (const error of report.analysisErrors) {
            const key = `${error.code ?? error.type}\0${error.sourceFile.fileName}\0${error.node.getStart(error.sourceFile)}\0${error.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            analysisErrors.push(error);
          }
        }
      } finally {
        releaseGraphCache(state);
        state.registeredTokens.clear();
        state.usedTokens.clear();
        state.generatedContainerVars.clear();
        // A build that is not a watch build is over once buildEnd has run: webpack and esbuild have no
        // closeBundle, so the session would otherwise live as long as the process.
        if (!watching) closeSession('keep');
      }

      const host = this as { warn?: (message: string) => void } | undefined;
      for (const warning of warnings) {
        if (typeof host?.warn === 'function') host.warn(warning);
        else console.warn(warning);
      }

      if (errors.length > 0) {
        const failure = new Error(
          `\n${'='.repeat(60)}\n` +
          `NEO-SYRINGE: ${errors.length} unregistered token(s) found!\n` +
          `${'='.repeat(60)}\n\n` +
          errors.join('\n\n') +
          `\n\n${'='.repeat(60)}\n`
        ) as Error & { analysisErrors?: AnalysisError[] };
        failure.analysisErrors = analysisErrors.filter((error) => error.severity !== 'warning');
        throw failure;
      }
    },

    watchChange(id, change) {
      watching = true;
      if (change.event === 'delete') {
        forgetDevtoolsFile(id);
        releaseGraphCache(state);
        // bind drops this file's keys. The published class has no public release yet.
        state.collisions?.bind(programFileName(id));
        for (const texts of sourceTexts.values()) texts.delete(programFileName(id));
      }
      applyWatchChange(state, normalizeModuleId(id), change.event, process.cwd(), project);
    },

    rollup: {
      closeBundle() {
        if (!this.meta.watchMode) {
          clearCollisions();
          closeSession('keep');
        }
      },
      closeWatcher() {
        clearCollisions();
        closeSession('free');
      },
    },

    vite: {
      closeBundle() {
        if (!this.meta.watchMode) {
          clearCollisions();
          closeSession('keep');
        }
      },
      closeWatcher() {
        clearCollisions();
        closeSession('free');
      },
      async configureServer(server) {
        if (process.env.NODE_ENV === 'production') return;
        if (options.devtools !== true) return;
        // Vite awaits this hook. A failed load rejects it with the load's own error, and the next call loads again.
        // `serving` turns on after the load: a failed load installs no middleware, so no graph may be kept for it.
        const { createDevtoolsMiddleware } = await loadDevtools();
        serving = true;
        const middleware = createDevtoolsMiddleware(() => [...state.devtoolsGraphs.values()]);
        server.middlewares.use(middleware);
        // eslint-disable-next-line no-console
        console.log('[NeoSyringe] Devtools available at /__neosyringe/');
      },
    },
  };
  Object.defineProperty(plugin, sessionStateKey, { value: state });
  return plugin;
});
