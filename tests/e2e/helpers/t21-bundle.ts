import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real esbuild plus the real built plugin, production mode, like tests/e2e/t20-docs-examples.test.ts.
// Needs a fresh `pnpm build` (packages/unplugin/dist).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginRequire = createRequire(path.join(repoRoot, 'packages/unplugin/package.json'));

interface EsbuildMetafile {
  inputs: Record<string, unknown>;
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
}

interface EsbuildBundle {
  build: (options: {
    absWorkingDir: string;
    entryPoints: string[];
    bundle: boolean;
    write: boolean;
    metafile: boolean;
    format: 'cjs';
    platform: 'node';
    define: Record<string, string>;
    plugins: { name: string; setup: (build: object) => void }[];
  }) => Promise<{ outputFiles?: { text: string }[]; metafile?: EsbuildMetafile }>;
}

interface PluginBundle {
  neoSyringePlugin: { esbuild: (options: { project: string }) => { name: string; setup: (build: object) => void } };
}

export interface BundleResult {
  code: string;
  /** Modules esbuild loaded (metafile.inputs), relative to the bundle directory. */
  inputs: string[];
  /** Modules that put bytes in an output (metafile.outputs[*].inputs), relative to the bundle directory. */
  outputInputs: string[];
}

/** Bundles `files` (relative path to text) from app.ts with the real esbuild plugin. */
export async function bundleApp(files: Record<string, string>): Promise<BundleResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 't21-bundle-'));
  const syringe = path.join(repoRoot, 'packages/neosyringe').replace(/\\/g, '/');
  const previous = process.env.NODE_ENV;
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        baseUrl: '.',
        paths: { '@djodjonx/neosyringe': [syringe] },
      },
      include: ['**/*.ts'],
    }));
    const plugin = pluginRequire('./dist/index.cjs') as PluginBundle;
    const esbuild = pluginRequire('esbuild') as EsbuildBundle;
    process.env.NODE_ENV = 'production';
    const result = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: ['app.ts'],
      bundle: true,
      write: false,
      metafile: true,
      format: 'cjs',
      platform: 'node',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [plugin.neoSyringePlugin.esbuild({ project: path.join(dir, 'tsconfig.json') })],
    });
    const metafile = result.metafile;
    if (metafile === undefined) throw new Error('esbuild returned no metafile');
    const outputs = Object.values(metafile.outputs);
    return {
      code: result.outputFiles?.[0]?.text ?? '',
      inputs: Object.keys(metafile.inputs),
      outputInputs: outputs.flatMap((output) => (
        Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file)
      )),
    };
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Executes a cjs bundle that exports `run` and returns what `run()` resolves to. */
export async function runBundle(code: string): Promise<unknown> {
  const record: { exports: { run?: () => unknown } } = { exports: {} };
  const execute = new Function('module', 'exports', 'require', code) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
  ) => void;
  execute(record, record.exports, (id: string) => {
    throw new Error(`unexpected require ${id}`);
  });
  const run = record.exports.run;
  if (typeof run !== 'function') throw new Error('bundle did not export run');
  return run();
}
