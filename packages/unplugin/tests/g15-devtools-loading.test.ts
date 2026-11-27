import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TSContext } from '@djodjonx/neosyringe-core/context';

/**
 * The devtools module (the HTTP middleware and, through it, the HTML renderer) is evaluated only when the dev server
 * serves the devtools. `loads` counts the evaluations of `../src/devtools`; `broken` makes the next one fail.
 */
const loads = vi.hoisted(() => ({ count: 0, broken: false }));

/** Registers the counting mock of the devtools module. `vi.doMock` forgets the module evaluated by an earlier test. */
function mockDevtools(): void {
  vi.doMock('../src/devtools', async (importOriginal) => {
    loads.count += 1;
    if (loads.broken) throw new Error('devtools chunk is missing');
    return importOriginal();
  });
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

interface FakeServer {
  middlewares: { use: (fn: Middleware) => void };
}

interface Served {
  server: FakeServer;
  installed: Middleware[];
}

function fakeServer(): Served {
  const installed: Middleware[] = [];
  return {
    installed,
    server: {
      middlewares: {
        use(fn) {
          installed.push(fn);
        },
      },
    },
  };
}

/** The `configureServer` hook of a plugin made by `neoSyringePlugin.vite`, called as the dev server calls it. */
async function configure(plugin: object, served: Served): Promise<void> {
  const own = Reflect.get(plugin, 'configureServer');
  const nested = Reflect.get(Reflect.get(plugin, 'vite') ?? {}, 'configureServer');
  const hook: unknown = typeof own === 'function' ? own : nested;
  if (typeof hook !== 'function') throw new Error('configureServer absent');
  await Reflect.apply(hook, plugin, [served.server]);
}

/** A fresh copy of the plugin module, so that `loads` counts what this plugin evaluates and nothing before. */
async function freshPlugin(): Promise<typeof import('../src/index').neoSyringePlugin> {
  vi.resetModules();
  mockDevtools();
  loads.count = 0;
  loads.broken = false;
  const loaded = await import('../src/index');
  return loaded.neoSyringePlugin;
}

/** The messages of an error and of its `cause` chain. Vitest wraps the error of a failing mock factory. */
function chain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 5) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' <- ');
}

function body(middleware: Middleware | undefined, url: string): { type: string; text: string } {
  if (middleware === undefined) throw new Error('middleware absent');
  let type = '';
  let text = '';
  const response = {
    setHeader(name: string, value: string) {
      if (name === 'Content-Type') type = value;
    },
    end(chunk?: string) {
      text = chunk ?? '';
    },
  };
  const req = { url };
  middleware(
    // The middleware reads `url` only.
    Object.assign(Object.create(null), req),
    Object.assign(Object.create(null), response),
    () => {
      text = 'next';
    },
  );
  return { type, text };
}

const dirs: string[] = [];

afterEach(() => {
  loads.broken = false;
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const CONTAINER = `
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

/** A temporary project that resolves `@djodjonx/neosyringe` to its source: its tsconfig and the id of one container. */
function project(): { tsconfig: string; id: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'g15-devtools-loading-'));
  dirs.push(dir);
  const tsconfig = path.join(dir, 'tsconfig.json');
  writeFileSync(tsconfig, JSON.stringify({
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
      paths: { '@djodjonx/neosyringe': [path.join(repoRoot, 'packages/neosyringe/src/index.ts')] },
    },
    include: ['*.ts'],
  }));
  return { tsconfig, id: path.join(dir, 'container.ts') };
}

/**
 * The number of graphs the plugin keeps for the devtools. `freshPlugin` resets the modules, so the key of the state is
 * the symbol this plugin carries, found by its description, not the one this file imports.
 */
function keptGraphs(plugin: object): number {
  const key = Object.getOwnPropertySymbols(plugin).find((symbol) => symbol.description === 'neoSyringe.sessionState');
  if (key === undefined) throw new Error('missing session state key');
  const state: unknown = Reflect.get(plugin, key);
  const graphs: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'devtoolsGraphs') : undefined;
  if (!(graphs instanceof Map)) throw new Error('missing session state');
  return graphs.size;
}

/** Runs the plugin's `transform` hook on a container source, as the bundler does. */
function transform(plugin: object, code: string, id: string): void {
  const hook: unknown = Reflect.get(plugin, 'transform');
  if (typeof hook !== 'function') throw new Error('transform absent');
  Reflect.apply(hook, plugin, [code, id]);
}

describe('G15 devtools loading', () => {
  it('devtools module is not evaluated when devtools off', async () => {
    const neoSyringePlugin = await freshPlugin();
    for (const options of [{ devtools: false }, {}] as const) {
      const served = fakeServer();
      await configure(neoSyringePlugin.vite(options), served);
      expect(served.installed).toHaveLength(0);
    }
    expect(loads.count).toBe(0);
  });

  it('devtools module is not evaluated in production', async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const neoSyringePlugin = await freshPlugin();
      const served = fakeServer();
      await configure(neoSyringePlugin.vite({ devtools: true }), served);
      expect(served.installed).toHaveLength(0);
      expect(loads.count).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('devtools module is loaded once and serves /__neosyringe/ when on', async () => {
    const neoSyringePlugin = await freshPlugin();
    const first = fakeServer();
    const second = fakeServer();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await configure(neoSyringePlugin.vite({ devtools: true }), first);
      await configure(neoSyringePlugin.vite({ devtools: true }), second);
    } finally {
      log.mockRestore();
    }
    expect(loads.count).toBe(1);
    expect(first.installed).toHaveLength(1);
    expect(second.installed).toHaveLength(1);
    const page = body(first.installed[0], '/__neosyringe/');
    expect(page.type).toContain('text/html');
    expect(page.text).toMatch(/<!DOCTYPE html>/);
    expect(body(second.installed[0], '/__neosyringe/data.json').text).toBe('[]');
  });

  it('a failed devtools load rejects configureServer with its error, and the next call retries', async () => {
    const neoSyringePlugin = await freshPlugin();
    const { tsconfig, id } = project();
    const plugin = neoSyringePlugin.vite({ devtools: true, project: tsconfig });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      loads.broken = true;
      const failed = fakeServer();
      const failure = await configure(plugin, failed).then(() => undefined, (error: unknown) => error);
      expect(failure, 'configureServer rejected').toBeInstanceOf(Error);
      expect(chain(failure)).toContain('devtools chunk is missing');
      expect(failed.installed).toHaveLength(0);
      // No middleware serves the graphs, so a transform after the failed load keeps none.
      transform(plugin, CONTAINER, id);
      expect(keptGraphs(plugin), 'graphs kept after a failed load').toBe(0);

      loads.broken = false;
      const retried = fakeServer();
      await configure(plugin, retried);
      expect(retried.installed).toHaveLength(1);
      transform(plugin, CONTAINER, id);
      expect(keptGraphs(plugin), 'graphs kept once the middleware serves').toBe(1);
      expect(body(retried.installed[0], '/__neosyringe/').text).toMatch(/<!DOCTYPE html>/);
    } finally {
      log.mockRestore();
    }
  });
});
