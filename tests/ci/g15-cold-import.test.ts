import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The plugin loads the HTML renderer only when the dev server serves the devtools. A process that imports the
 * published plugin with `devtools: false` and transforms one container must not load a module that holds the renderer.
 * Needs `pnpm build`. The load hook below is `module.register`, available from Node 20.6, so it runs on the whole CI matrix.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginDist = path.join(root, 'packages/unplugin/dist');
const RENDERER = 'buildStandaloneHtml';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-g15-cold-'));
  dirs.push(dir);
  return dir;
}

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

/** Logs the URL of every module the ESM loader reads, from the loader thread, before the module runs. */
const HOOKS = `
import { appendFileSync } from 'node:fs';
let logFile;
export function initialize(data) {
  logFile = data.logFile;
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) appendFileSync(logFile, url + '\\n');
  return nextLoad(url, context);
}
`;

const PRELOAD = `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL(process.env.G15_HOOKS).href, { parentURL: import.meta.url, data: { logFile: process.env.G15_LOG } });
`;

/** Both children import the plugin, make a vite plugin with devtools off, transform one container and print what was loaded. */
const REPORT = `
const code = (output) => (typeof output === 'string' ? output : output && typeof output.code === 'string' ? output.code : '');
`;

const CHILD_ESM = `${REPORT}
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { neoSyringePlugin } = await import(pathToFileURL(process.env.G15_ENTRY).href);
const plugin = neoSyringePlugin.vite({ devtools: false, project: process.env.G15_PROJECT });
const output = await plugin.transform(process.env.G15_CODE, process.env.G15_ID);
const cache = Object.keys(createRequire(import.meta.url).cache);
process.stdout.write(JSON.stringify({ transformed: code(output).includes('class NeoContainer_'), cache }));
`;

const CHILD_CJS = `${REPORT}
const { neoSyringePlugin } = require(process.env.G15_ENTRY);
const plugin = neoSyringePlugin.vite({ devtools: false, project: process.env.G15_PROJECT });
Promise.resolve(plugin.transform(process.env.G15_CODE, process.env.G15_ID)).then((output) => {
  process.stdout.write(JSON.stringify({ transformed: code(output).includes('class NeoContainer_'), cache: Object.keys(require.cache) }));
});
`;

interface ChildReport {
  transformed: boolean;
  /** Every file the child loaded, by path: the loader hook sees ESM, `require.cache` sees CommonJS. */
  loaded: string[];
}

function parseReport(text: string): { transformed: boolean; cache: string[] } {
  const parsed: unknown = JSON.parse(text.slice(text.indexOf('{')));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`child report is not an object: ${text}`);
  const transformed = Reflect.get(parsed, 'transformed');
  const cache = Reflect.get(parsed, 'cache');
  if (typeof transformed !== 'boolean' || !Array.isArray(cache)) throw new Error(`child report has the wrong shape: ${text}`);
  return { transformed, cache: cache.filter((item): item is string => typeof item === 'string') };
}

function runChild(format: 'esm' | 'cjs'): ChildReport {
  const dir = temp();
  const logFile = path.join(dir, 'loaded.log');
  writeFileSync(logFile, '');
  writeFileSync(path.join(dir, 'hooks.mjs'), HOOKS);
  writeFileSync(path.join(dir, 'preload.mjs'), PRELOAD);
  const child = path.join(dir, format === 'esm' ? 'child.mjs' : 'child.cjs');
  writeFileSync(child, format === 'esm' ? CHILD_ESM : CHILD_CJS);
  const project = path.join(dir, 'tsconfig.json');
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
      paths: { '@djodjonx/neosyringe': [path.join(root, 'packages/neosyringe/src/index.ts')] },
    },
    include: ['*.ts'],
  }));
  const id = path.join(dir, 'container.ts');
  writeFileSync(id, CONTAINER);
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(dir, 'preload.mjs')).href, child], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      G15_HOOKS: path.join(dir, 'hooks.mjs'),
      G15_LOG: logFile,
      G15_ENTRY: path.join(pluginDist, format === 'esm' ? 'index.mjs' : 'index.cjs'),
      G15_PROJECT: project,
      G15_CODE: CONTAINER,
      G15_ID: id,
    },
  });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  const report = parseReport(run.stdout);
  const hooked = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((url) => fileURLToPath(url));
  return { transformed: report.transformed, loaded: [...new Set([...hooked, ...report.cache])] };
}

describe('G15 cold import', () => {
  it.each(['esm', 'cjs'] as const)('plugin dist loads no html module with devtools off (%s)', (format) => {
    const entry = path.join(pluginDist, format === 'esm' ? 'index.mjs' : 'index.cjs');
    expect(existsSync(entry), entry).toBe(true);
    const report = runChild(format);
    // The child reached the real path: the plugin file was loaded and the container was compiled.
    expect(report.loaded, 'plugin entry loaded').toContain(entry);
    expect(report.transformed, 'container compiled').toBe(true);
    const ours = report.loaded.filter((file) => file.startsWith(path.join(root, 'packages') + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`));
    const holders = ours.filter((file) => readFileSync(file, 'utf8').includes(RENDERER));
    expect(holders.map((file) => path.relative(root, file))).toEqual([]);
  }, 120_000);
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** The file names under dist, the plugin entries and chunks, for one module format. */
function distFiles(extension: '.mjs' | '.cjs'): string[] {
  return readdirSync(pluginDist).filter((name) => name.endsWith(extension)).sort();
}

/**
 * The regex of a dynamic load of the chunk `name` (already escaped) in one module format. The CommonJS form is the one
 * the build emits, `.then(() => require("./chunk"))`: a bare `require` at the top level is a static load.
 */
function dynamicReference(format: 'esm' | 'cjs', name: string): RegExp {
  return format === 'esm'
    ? new RegExp(String.raw`\bimport\(\s*["']\./${name}["']\s*\)`)
    : new RegExp(String.raw`\.then\(\(\)\s*=>\s*require\(\s*["']\./${name}["']\s*\)\)`);
}

describe('G15 devtools chunk', () => {
  it.each(['esm', 'cjs'] as const)('unplugin dist entry reaches devtools only through a dynamic import (%s)', (format) => {
    const extension = format === 'esm' ? '.mjs' : '.cjs';
    const entryName = `index${extension}`;
    expect(existsSync(path.join(pluginDist, entryName)), entryName).toBe(true);
    const files = distFiles(extension);
    const read = (name: string): string => readFileSync(path.join(pluginDist, name), 'utf8');
    // The chunk that holds the middleware is another file than the entry.
    const definers = files.filter((name) => /function\s+createDevtoolsMiddleware\b/.test(read(name)));
    expect(definers, 'files that define the devtools middleware').toHaveLength(1);
    const chunk = definers[0];
    if (chunk === undefined) throw new Error('unreachable: length checked above');
    expect(chunk).not.toBe(entryName);
    // Another file may name the chunk only inside a dynamic import. A static one, at the top level, loads it with the entry.
    const name = escapeRegExp(chunk);
    const staticReference = format === 'esm'
      ? new RegExp(String.raw`^(?:import|export)\b[^;]*?["']\./${name}["']`, 'm')
      : new RegExp(String.raw`^(?:const|let|var)\s+\S+\s*=\s*(?:\w+\()?require\(\s*["']\./${name}["']\s*\)`, 'm');
    const statics = files.filter((candidate) => candidate !== chunk && staticReference.test(read(candidate)));
    expect(statics, 'files that load the devtools chunk with the entry').toEqual([]);
    expect(dynamicReference(format, name).test(read(entryName)), `${entryName} names ${chunk} in a dynamic import`).toBe(true);
  });

  it.each([
    { format: 'esm', source: 'const load = () => import("./chunk.mjs");', dynamic: true },
    { format: 'esm', source: 'import { a } from "./chunk.mjs";', dynamic: false },
    { format: 'cjs', source: 'const load = () => Promise.resolve().then(() => require("./chunk.cjs"));', dynamic: true },
    { format: 'cjs', source: 'const chunk = require("./chunk.cjs");', dynamic: false },
    { format: 'cjs', source: 'const { a } = require("./chunk.cjs");', dynamic: false },
  ] as const)('the dynamic reference of $format matches $source: $dynamic', ({ format, source, dynamic }) => {
    const file = format === 'esm' ? 'chunk\\.mjs' : 'chunk\\.cjs';
    expect(dynamicReference(format, file).test(source)).toBe(dynamic);
  });
});
