import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Same path on every call. Token ids include the file hash
// (packages/core/src/analyzer/shared/HashUtils.ts:127).
const VIRTUAL_FILE_ID = path.join(process.cwd(), 'tests/e2e/fixtures/t00-program.ts');

// dist/ is gitignored (.gitignore:6). test:e2e does not build (package.json:11).
const BUILD_HINT = 'pnpm build';
const DIST_PAIRS = [
  ['packages/unplugin/dist/index.mjs', 'packages/unplugin/src'],
  ['packages/core/dist/TSContext.mjs', 'packages/core/src'],
  ['packages/neosyringe/dist/index.cjs', 'packages/neosyringe/src'],
] as const;

export type HarnessOutcome =
  | { phase: 'build'; diagnostic: string }
  | { phase: 'runtime'; error: string; transformed: boolean; stage: RuntimeStage }
  | { phase: 'ok'; value: unknown; transformed: boolean };

type RuntimeStage = 'load' | 'run';
type TransformOutput = string | { code?: string } | null | undefined;

interface SyringeBuildPlugin {
  transform(code: string, id: string): TransformOutput;
  buildEnd(): void;
}

interface PluginModule {
  neoSyringePlugin: { vite: () => SyringeBuildPlugin };
}

interface CoreModule {
  TSContext: { reset: () => void };
}

class StagedError extends Error {
  readonly stage: RuntimeStage;

  constructor(cause: unknown, stage: RuntimeStage) {
    super(errorText(cause));
    this.name = 'StagedError';
    this.stage = stage;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageOf(error: unknown): RuntimeStage {
  return error instanceof StagedError ? error.stage : 'run';
}

function newestSourceMtime(srcDir: string): number | null {
  if (!existsSync(srcDir)) return null;
  let newest: number | null = null;
  const pending = [srcDir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile()) {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

export function assertDistFresh(distFile: string, srcDir: string): void {
  if (!existsSync(distFile)) {
    throw new Error(`missing build output ${distFile}; run ${BUILD_HINT} before pnpm test:e2e`);
  }
  const newestSrc = newestSourceMtime(srcDir);
  if (newestSrc !== null && statSync(distFile).mtimeMs < newestSrc) {
    throw new Error(`stale build output ${distFile}; run ${BUILD_HINT} before pnpm test:e2e`);
  }
}

function generatedSource(output: TransformOutput, source: string): { code: string; transformed: boolean } {
  let transformed = false;
  if (typeof output === 'string') {
    transformed = true;
    return { code: output, transformed };
  }
  if (output && typeof output.code === 'string') {
    transformed = true;
    return { code: output.code, transformed };
  }
  return { code: source, transformed };
}

function compileProgram(pluginModule: PluginModule, source: string): { code: string; transformed: boolean } {
  const plugin = pluginModule.neoSyringePlugin.vite();
  const output = plugin.transform(source, VIRTUAL_FILE_ID);
  plugin.buildEnd();
  return generatedSource(output, source);
}

function loadModule(
  javascript: string,
  requireImpl: (specifier: string) => unknown,
): { run?: () => unknown } {
  const exportsObject: { run?: () => unknown } = {};
  // eslint-disable-next-line no-new-func
  const execute = new Function('exports', 'require', javascript) as (
    exportsObject: { run?: () => unknown },
    requireImpl: (specifier: string) => unknown,
  ) => void;
  try {
    execute(exportsObject, requireImpl);
  } catch (error) {
    throw new StagedError(error, 'load');
  }
  return exportsObject;
}

function runCompiled(javascript: string): Promise<unknown> {
  const requireFromPackage = createRequire(
    pathToFileURL(path.join(process.cwd(), 'packages/neosyringe/package.json')).href,
  );
  const runtime: unknown = requireFromPackage('@djodjonx/neosyringe');
  const exportsObject = loadModule(javascript, (specifier) => (
    specifier === '@djodjonx/neosyringe' ? runtime : requireFromPackage(specifier)
  ));
  const run = exportsObject.run;
  if (typeof run !== 'function') {
    throw new StagedError(new Error('fixture did not export run'), 'load');
  }
  try {
    return Promise.resolve(run());
  } catch (error) {
    throw new StagedError(error, 'run');
  }
}

export async function executeFixture(source: string): Promise<HarnessOutcome> {
  for (const [distRel, srcRel] of DIST_PAIRS) {
    assertDistFresh(path.join(process.cwd(), distRel), path.join(process.cwd(), srcRel));
  }
  const pluginModule = await import('../../../packages/unplugin/dist/index.mjs') as PluginModule;
  const coreModule = await import('../../../packages/core/dist/TSContext.mjs') as CoreModule;
  try {
    let generated: { code: string; transformed: boolean };
    try {
      generated = compileProgram(pluginModule, source);
    } catch (error) {
      return { phase: 'build', diagnostic: errorText(error) };
    }

    const javascript = ts.transpileModule(generated.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const transformed = generated.transformed;

    try {
      const value = await runCompiled(javascript);
      return { phase: 'ok', value, transformed };
    } catch (error) {
      return { phase: 'runtime', error: errorText(error), transformed, stage: stageOf(error) };
    }
  } finally {
    coreModule.TSContext.reset();
  }
}
