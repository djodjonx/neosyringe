import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real Vite and webpack production builds, using the built plugin
// (packages/unplugin/dist/index.cjs). The factory reads NODE_ENV when it is
// called (packages/unplugin/src/index.ts:66, packages/core/src/generator/DebugConfig.ts:22).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginRequire = createRequire(path.join(repoRoot, 'packages/unplugin/package.json'));
const loaderPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'esbuild-ts-loader.cjs');

export interface BundlerBuild {
  code: string;
}

interface PluginApi {
  neoSyringePlugin: {
    vite: (options: { project: string }) => { name: string };
    webpack: (options: { project: string }) => { apply: (compiler: object) => void };
  };
}

interface ViteChunk {
  type: string;
  code?: string;
}

interface ViteOutput {
  output?: ViteChunk[];
}

interface ViteModule {
  build: (config: object) => Promise<ViteOutput | ViteOutput[]>;
}

interface WebpackCompiler {
  close: (callback: (error: Error | null) => void) => void;
}

interface WebpackModule {
  (config: object, callback: (error: Error | null) => void): WebpackCompiler;
}

function writeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't22-bundle-'));
  const syringe = path.join(repoRoot, 'packages/neosyringe').replace(/\\/g, '/');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  // Same paths block as tests/e2e/helpers/t21-bundle.ts:54-64.
  // Passed as `project` (packages/unplugin/src/index.ts:30) and loaded at
  // packages/unplugin/src/session.ts:306-308.
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
  return dir;
}

function restoreEnv(previous: string | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
  else process.env.NODE_ENV = previous;
}

function chunkCode(result: ViteOutput | ViteOutput[]): string {
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((item) => item.output ?? [])
    .filter((item) => item.type === 'chunk')
    .map((item) => item.code ?? '')
    .join('\n');
}

export function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (value == null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) parts.push(value.message);
    if ('message' in value && typeof value.message === 'string' && !(value instanceof Error)) {
      parts.push(value.message);
    }
    if ('errors' in value && Array.isArray(value.errors)) {
      for (const item of value.errors) visit(item);
    }
    if ('cause' in value) visit(value.cause);
  };
  visit(error);
  return parts.join('\n');
}

export async function buildWithVite(files: Record<string, string>): Promise<BundlerBuild> {
  const dir = writeProject(files);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const plugin = pluginRequire('./dist/index.cjs') as PluginApi;
    const vite = pluginRequire('vite') as ViteModule;
    const project = path.join(dir, 'tsconfig.json');
    const result = await vite.build({
      configFile: false,
      mode: 'production',
      root: dir,
      publicDir: false,
      logLevel: 'silent',
      plugins: [plugin.neoSyringePlugin.vite({ project })],
      build: {
        lib: {
          entry: path.join(dir, 'app.ts'),
          formats: ['cjs'],
          fileName: 'app',
        },
        write: false,
      },
    });
    return { code: chunkCode(result) };
  } finally {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildWithWebpack(files: Record<string, string>): Promise<BundlerBuild> {
  const dir = writeProject(files);
  const outDir = path.join(dir, 'dist');
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    const plugin = pluginRequire('./dist/index.cjs') as PluginApi;
    const webpack = pluginRequire('webpack') as WebpackModule;
    const project = path.join(dir, 'tsconfig.json');
    await new Promise<void>((resolve, reject) => {
      let compiler: WebpackCompiler | undefined;
      const finish = (error: unknown): void => {
        const done = (): void => {
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        };
        if (!compiler) {
          done();
          return;
        }
        compiler.close(() => done());
      };
      try {
        compiler = webpack({
          mode: 'production',
          target: 'node',
          context: dir,
          entry: path.join(dir, 'app.ts'),
          output: {
            path: outDir,
            filename: 'app.cjs',
            library: { type: 'commonjs2' },
          },
          resolve: {
            extensions: ['.ts', '.js'],
          },
          module: {
            rules: [{
              test: /\.ts$/,
              use: [loaderPath],
            }],
          },
          plugins: [plugin.neoSyringePlugin.webpack({ project })],
          infrastructureLogging: { level: 'error' },
        }, (error) => {
          // Callback error only. A missing provider throws at
          // packages/unplugin/src/index.ts:168. This helper does not read stats.
          finish(error);
        });
      } catch (error) {
        finish(error);
      }
    });
    return { code: readFileSync(path.join(outDir, 'app.cjs'), 'utf8') };
  } finally {
    restoreEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}
