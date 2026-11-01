import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as esbuild from 'esbuild';
import { rollup, type RollupBuild } from 'rollup';
import { TSContext } from '@djodjonx/neosyringe-core/context';

// The plugin imports @djodjonx/neosyringe-ui from dist. Follow src so the
// serializeGraph fields land in data.json without a rebuild.
vi.mock('@djodjonx/neosyringe-ui', () => import('../../ui/src/index'));
import { neoSyringePlugin } from '../src/index';

const dirs: string[] = [];

afterEach(() => {
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Next = () => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

type ServedGraph = {
  exportedVariableName?: string;
  containerKey?: string;
  nodes: { tokenId: string }[];
};

type Hooks = {
  transform: (code: string, id: string) => unknown;
  configureServer: (server: { middlewares: { use: (fn: Middleware) => void } }) => void;
  watchChange?: (id: string, change: { event: 'create' | 'update' | 'delete' }) => void;
};

type Session = {
  id: string;
  installed: boolean;
  transform: (code: string) => unknown;
  serve: () => void;
  read: () => ServedGraph[];
  body: (url: string) => string;
  watchDelete: () => void;
  middleware: () => Middleware;
};

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  for (;;) {
    try {
      readFileSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('racine du dépôt introuvable');
      dir = parent;
    }
  }
}

const CACHE = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface Cache {
  get(key: string): string;
}
export class MemoryCache implements Cache {
  get(key: string): string {
    return key;
  }
}

export const appContainer = defineBuilderConfig({
  injections: [{ token: useInterface<Cache>(), provider: MemoryCache }],
});
`;

const PAIR = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface LeftMark { side: string }
export interface RightMark { side: string }
export class LeftImpl implements LeftMark { side = 'left'; }
export class RightImpl implements RightMark { side = 'right'; }

export const left = defineBuilderConfig({
  injections: [{ token: useInterface<LeftMark>(), provider: LeftImpl }],
});
export const right = defineBuilderConfig({
  injections: [{ token: useInterface<RightMark>(), provider: RightImpl }],
});
`;

const BOTH = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface Kept { id: number }
export interface Removed { id: number }
export class KeptImpl implements Kept { id = 1; }
export class RemovedImpl implements Removed { id = 2; }

export const appContainer = defineBuilderConfig({
  injections: [
    { token: useInterface<Kept>(), provider: KeptImpl },
    { token: useInterface<Removed>(), provider: RemovedImpl },
  ],
});
`;

const KEPT_ONLY = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface Kept { id: number }
export class KeptImpl implements Kept { id = 1; }

export const appContainer = defineBuilderConfig({
  injections: [{ token: useInterface<Kept>(), provider: KeptImpl }],
});
`;

const IMPORT_ONLY = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const appContainer = 1;
`;

const NO_MARKER = `
export const appContainer = 1;
`;

const LOCAL_MARKER = `
function defineBuilderConfig(config: { injections: unknown[] }): { injections: unknown[] } {
  return config;
}

export const appContainer = defineBuilderConfig({ injections: [] });
`;

const BARE_RETURN = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface Cache {
  get(key: string): string;
}
export class MemoryCache implements Cache {
  get(key: string): string {
    return key;
  }
}

export function buildContainer() {
  return defineBuilderConfig({
    injections: [{ token: useInterface<Cache>(), provider: MemoryCache }],
  });
}
`;

function getterBody(code: string, name: string): string {
  const match = code.match(new RegExp(String.raw`get ${name}\(\)\s*\{([^}]*)\}`));
  if (!match?.[1]) throw new Error(`getter ${name} absent`);
  return match[1].replace(/\s+/g, '');
}

function named(name: string, token: string): string {
  return `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface ${token} { id: number }
export class ${token}Impl implements ${token} { id = 1; }

export const ${name} = defineBuilderConfig({
  injections: [{ token: useInterface<${token}>(), provider: ${token}Impl }],
});
`;
}

function start(options?: { devtools?: boolean; project?: string; bundler?: 'vite' | 'rollup' }): Session {
  const dir = mkdtempSync(path.join(tmpdir(), 't12-devtools-'));
  dirs.push(dir);
  const project = options?.project ?? path.join(dir, 'tsconfig.json');
  if (options?.project === undefined) {
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Bundler',
        strict: true,
        noLib: true,
        types: [],
        skipLibCheck: true,
        esModuleInterop: true,
        baseUrl: '.',
        paths: {
          '@djodjonx/neosyringe': [path.join(repoRoot(), 'packages/neosyringe/src/index.ts')],
        },
      },
      include: ['*.ts'],
    }));
  }
  const pluginOptions = options?.devtools === undefined
    ? { project }
    : { devtools: options.devtools, project };
  const created = options?.bundler === 'rollup'
    ? neoSyringePlugin.rollup(pluginOptions)
    : neoSyringePlugin.vite(pluginOptions);
  const plugin = created as unknown as Hooks & {
    vite?: { configureServer?: Hooks['configureServer'] };
  };
  const id = path.join(dir, 'container.ts');
  let installed = false;
  let middleware: Middleware | undefined;
  const serve = (): void => {
    const configure = plugin.configureServer ?? plugin.vite?.configureServer;
    if (!configure) throw new Error('configureServer absent');
    configure({
      middlewares: {
        use(fn) {
          installed = true;
          middleware = fn;
        },
      },
    });
  };
  const body = (url: string): string => {
    if (!middleware) throw new Error('middleware absent');
    let payload = '';
    const response = {
      setHeader() {},
      end(chunk?: string) { payload = chunk ?? ''; },
    };
    middleware({ url } as IncomingMessage, response as unknown as ServerResponse, () => {
      payload = 'next';
    });
    return payload;
  };
  return {
    id,
    get installed() { return installed; },
    transform(code: string) {
      return plugin.transform(code, id);
    },
    serve,
    read() {
      return JSON.parse(body('/__neosyringe/data.json')) as ServedGraph[];
    },
    body,
    watchDelete() {
      plugin.watchChange?.(id, { event: 'delete' });
    },
    middleware() {
      if (!middleware) throw new Error('middleware absent');
      return middleware;
    },
  };
}

function tokenIds(graphs: ServedGraph[]): string[] {
  return graphs.flatMap((graph) => graph.nodes.map((node) => node.tokenId));
}

describe('T12 devtools', () => {
  it('T12-A01 devtools lists the container', () => {
    const session = start({ devtools: true });
    session.serve();
    expect(session.read()).toEqual([]);
    session.transform(CACHE);
    const data = session.read();
    expect(data).toHaveLength(1);
    expect(data[0]?.exportedVariableName).toBe('appContainer');
    expect(tokenIds(data).some((tokenId) => tokenId.includes('Cache'))).toBe(true);
  });

  it('T12-A02 two containers in one file', () => {
    const session = start({ devtools: true });
    session.serve();
    session.transform(PAIR);
    const data = session.read();
    expect(data).toHaveLength(2);
    expect(new Set(data.map((graph) => graph.containerKey)).size).toBe(2);
    expect(data.map((graph) => graph.exportedVariableName).sort()).toEqual(['left', 'right']);
  });

  it('T12-A03 removed containers leave no stale entry', () => {
    const session = start({ devtools: true });
    session.serve();

    session.transform(BOTH);
    session.transform(KEPT_ONLY);
    const updated = tokenIds(session.read());
    expect(updated.some((tokenId) => tokenId.includes('Kept'))).toBe(true);
    expect(updated.some((tokenId) => tokenId.includes('Removed'))).toBe(false);

    session.transform(BOTH);
    session.transform(IMPORT_ONLY);
    expect(session.read()).toEqual([]);

    session.transform(BOTH);
    session.transform(NO_MARKER);
    expect(session.read()).toEqual([]);

    session.transform(BOTH);
    session.watchDelete();
    expect(session.read()).toEqual([]);
  });

  it('T12-A03 a local marker name drops the file', () => {
    const session = start({ devtools: true });
    session.serve();
    session.transform(CACHE);
    session.transform(LOCAL_MARKER);
    expect(session.read()).toEqual([]);
  });

  it('T12-A03 a throwing rebuild drops the file', () => {
    const session = start({ devtools: true });
    session.serve();
    session.transform(CACHE);
    expect(() => session.transform(BARE_RETURN)).toThrow(/must be assigned to a variable/);
    expect(session.read()).toEqual([]);
  });

  it('T12-A04 two sessions stay isolated', () => {
    const alpha = start({ devtools: true });
    const beta = start({ devtools: true });
    alpha.serve();
    beta.serve();
    alpha.transform(named('alphaContainer', 'AlphaMark'));
    beta.transform(named('betaContainer', 'BetaMark'));
    expect(alpha.read().map((graph) => graph.exportedVariableName)).toEqual(['alphaContainer']);
    expect(beta.read().map((graph) => graph.exportedVariableName)).toEqual(['betaContainer']);
  });

  it('T12-A05 devtools off installs nothing', () => {
    for (const devtools of [undefined, false] as const) {
      const session = devtools === undefined ? start() : start({ devtools });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        session.serve();
        expect(session.installed).toBe(false);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    }
  });

  it('T12-A06 production serves and bundles nothing', async () => {
    const previous = process.env.NODE_ENV;
    const restore = (): void => {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    };
    let bundle: RollupBuild | undefined;
    try {
      process.env.NODE_ENV = 'production';
      const blocked = start({ devtools: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        blocked.serve();
        expect(blocked.installed).toBe(false);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }

      restore();
      const produced = start({ devtools: true });
      produced.serve();
      process.env.NODE_ENV = 'production';
      produced.transform(CACHE);
      restore();
      expect(produced.read()).toEqual([]);

      const early = start({ devtools: true });
      early.transform(CACHE);
      early.serve();
      expect(early.read()).toEqual([]);

      process.env.NODE_ENV = 'production';
      const session = start({ devtools: true });
      writeFileSync(session.id, CACHE);
      const stripTypes = {
        name: 'strip-types',
        async transform(source: string, id: string) {
          if (!id.endsWith('.ts')) return null;
          const transformed = await esbuild.transform(source, {
            loader: 'ts',
            target: 'es2022',
            format: 'esm',
          });
          return { code: transformed.code, map: null };
        },
      };
      bundle = await rollup({
        input: session.id,
        external: (id) => id === '@djodjonx/neosyringe' || id.startsWith('@djodjonx/neosyringe/'),
        plugins: [neoSyringePlugin.rollup({
          devtools: true,
          debug: true,
          project: path.join(path.dirname(session.id), 'tsconfig.json'),
        }), stripTypes],
        onwarn(warning, warn) {
          if (warning.code === 'UNRESOLVED_IMPORT' || warning.code === 'SOURCEMAP_BROKEN') return;
          warn(warning);
        },
      });
      const generated = await bundle.generate({ format: 'esm' });
      const chunk = generated.output[0];
      expect(chunk?.type).toBe('chunk');
      if (chunk?.type !== 'chunk') return;
      expect(chunk.code).not.toContain('defineBuilderConfig(');
      expect(chunk.code).toContain('class NeoContainer_');
      expect(chunk.code).toMatch(/new NeoContainer_/);
      expect(getterBody(chunk.code, '_graph')).toBe('return[];');
      expect(getterBody(chunk.code, '_dependencyGraph')).toBe('return[];');
      expect(chunk.code).not.toContain('__neosyringe');
      expect(chunk.code).not.toContain('buildStandaloneHtml');
      expect(chunk.code).not.toContain('neosyringe-ui');
    } finally {
      await bundle?.close();
      restore();
    }
  });

  it('T12-A06 rollup without serve collects nothing', () => {
    const previous = process.env.NODE_ENV;
    try {
      if (previous === 'production') delete process.env.NODE_ENV;
      const session = start({ devtools: true, bundler: 'rollup' });
      const output = session.transform(CACHE);
      const code = typeof output === 'string'
        ? output
        : output && typeof output === 'object' && 'code' in output
          ? String((output as { code: unknown }).code)
          : '';
      expect(code).toContain('class NeoContainer_');
      session.serve();
      expect(session.read()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('T12-P8 http server serves html and json', async () => {
    const session = start({ devtools: true });
    session.serve();
    session.transform(CACHE);
    const middleware = session.middleware();
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = 404;
        res.end('next');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('port manquant');
      const base = `http://127.0.0.1:${address.port}`;
      const html = await (await fetch(`${base}/__neosyringe/`)).text();
      const json = await (await fetch(`${base}/__neosyringe/data.json`)).text();
      expect(html).toContain('appContainer');
      expect(json).toContain('Cache');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
