import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

const require = createRequire(import.meta.url);
const ROOT = repoRoot();

const dirs: string[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (!exists(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function exists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function chdir(dir: string): void {
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function neoPaths(): Record<string, string[]> {
  return {
    '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
  };
}

function writeTsconfig(dir: string, paths: Record<string, string[]> = {}): string {
  const file = path.join(dir, 'tsconfig.json');
  writeFileSync(file, JSON.stringify({
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
      paths: { ...neoPaths(), ...paths },
    },
    include: ['*.ts'],
  }));
  return file;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

type PluginHook = {
  transform: (code: string, id: string) => string | { code?: string; map?: unknown } | null | undefined;
  transformInclude: (id: string) => boolean;
  buildEnd: () => void;
};

function hooks(options?: { project?: string }): PluginHook {
  return neoSyringePlugin.vite(options) as unknown as PluginHook;
}

function codeOf(result: string | { code?: string } | null | undefined, fallback = ''): string {
  if (typeof result === 'string') return result;
  if (result && typeof result.code === 'string') return result.code;
  return fallback;
}

function mappedModule(dir: string, id: string): string | undefined {
  let paths: Record<string, string[]> | undefined;
  try {
    const config = JSON.parse(readFileSync(path.join(dir, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    paths = config.compilerOptions?.paths;
  } catch {
    return undefined;
  }
  if (!paths) return undefined;
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!target) continue;
    const star = pattern.indexOf('*');
    let replaced: string | undefined;
    if (star === -1) {
      if (id === pattern) replaced = target;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (id.startsWith(prefix) && id.endsWith(suffix) && id.length >= prefix.length + suffix.length) {
        const mid = id.slice(prefix.length, id.length - suffix.length);
        replaced = target.replace('*', mid);
      }
    }
    if (replaced) return `./${replaced.replace(/\.(ts|tsx|mts|cts)$/, '')}`;
  }
  return undefined;
}

function optionsOf(configPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  return parsed.options;
}

function emitProgram(program: ts.Program, dir: string): void {
  const diagnostics: string[] = [];
  const result = program.emit(undefined, (fileName, text) => {
    if (!fileName.endsWith('.js')) return;
    writeFileSync(path.join(dir, path.basename(fileName)), text);
  });
  for (const diagnostic of result.diagnostics) {
    diagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  if (result.emitSkipped) {
    throw new Error(`emit ignoré: ${diagnostics.join(' | ')}`);
  }
}

function runJs(dir: string, entry: string): Record<string, unknown> {
  const runtime = require(path.join(ROOT, 'packages/neosyringe/dist/index.cjs')) as Record<string, unknown>;
  const cache = new Map<string, Record<string, unknown>>();

  const req = (id: string): unknown => {
    if (id === '@djodjonx/neosyringe') return runtime;
    if (!id.startsWith('.')) {
      const mapped = mappedModule(dir, id);
      if (!mapped) throw new Error(`module inattendu: ${id}`);
      id = mapped;
    }
    const base = path.basename(id).replace(/\.(ts|js)$/, '');
    const file = path.join(dir, `${base}.js`);
    const hit = cache.get(file);
    if (hit) return hit;
    const exportsObject: Record<string, unknown> = {};
    cache.set(file, exportsObject);
    const body = readFileSync(file, 'utf8');
    const execute = new Function('exports', 'require', body) as (
      exportsObject: Record<string, unknown>,
      req: (id: string) => unknown,
    ) => void;
    execute(exportsObject, req);
    return exportsObject;
  };

  return req(`./${path.basename(entry).replace(/\.(ts|js)$/, '')}`) as Record<string, unknown>;
}

function pluginBundle(dir: string, files: Record<string, string>, entry: string, project: string): {
  texts: Map<string, string>;
  mod: Record<string, unknown>;
} {
  const plugin = hooks({ project });
  const texts = new Map<string, string>();
  for (const name of Object.keys(files)) {
    if (!name.endsWith('.ts')) continue;
    const id = path.join(dir, name);
    const output = plugin.transform(files[name], id);
    texts.set(name, codeOf(output, files[name]));
  }
  plugin.buildEnd();
  const out = path.join(dir, 'plugin-out');
  mkdirSync(out, { recursive: true });
  for (const [name, text] of texts) {
    const file = path.join(out, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(path.join(out, 'tsconfig.json'), readFileSync(project, 'utf8'));
  const options = optionsOf(path.join(out, 'tsconfig.json'));
  const program = ts.createProgram([path.join(out, entry)], options);
  emitProgram(program, out);
  return { texts, mod: runJs(out, entry) };
}

function memoryProgram(
  files: Map<string, string>,
  entry: string,
  options: ts.CompilerOptions,
): { program: ts.Program; host: ts.CompilerHost } {
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => files.get(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = files.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  return { program: ts.createProgram([entry], options, host), host };
}

function transformerBundle(
  dir: string,
  entry: string,
  project: string | undefined,
  files: Record<string, string>,
  virtual: boolean,
): { text: string; mod: Record<string, unknown>; error: string } {
  const configPath = project ?? path.join(dir, 'tsconfig.json');
  const options = optionsOf(configPath);
  const root = virtual ? path.join(dir, 'virtual') : dir;
  // The directory must exist. TypeScript skips relative lookup when it does not,
  // and never asks the in-memory host. The files themselves stay off disk.
  if (virtual) mkdirSync(root, { recursive: true });
  const mapped = new Map<string, string>();
  for (const [name, text] of Object.entries(files)) mapped.set(path.join(root, name), text);
  const entryPath = path.join(root, entry);
  const { program, host } = memoryProgram(mapped, entryPath, options);
  const out = path.join(dir, 'transformer-out');
  let text = '';
  try {
    const next = neoSyringeTransformer(program, host, { project: configPath }, { ts });
    text = next.getSourceFile(entryPath)?.text ?? '';
    mkdirSync(out, { recursive: true });
    emitProgram(next, out);
    return { text, mod: runJs(out, entry), error: '' };
  } catch (error) {
    return { text, mod: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

const CONTAINERS = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export interface LeftMark { side: string }
export interface RightMark { side: string }
export class LeftImpl implements LeftMark { side = 'left'; }
export class RightImpl implements RightMark { side = 'right'; }

const leftToken = useInterface<LeftMark>();
const rightToken = useInterface<RightMark>();

export const left = defineBuilderConfig({
  injections: [{ token: leftToken, provider: LeftImpl }],
});
export const right = defineBuilderConfig({
  injections: [{ token: rightToken, provider: RightImpl }],
});
export const empty = defineBuilderConfig({
  injections: [],
});

export function leftInstance() { return left.resolve(leftToken); }
export function rightInstance() { return right.resolve(rightToken); }
`;

describe('T11 pipeline', () => {
  it('T11-P1-container-set', () => {
    const dir = tempDir('t11-p1-');
    const project = writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': CONTAINERS });
    chdir(dir);

    const files = { 'app.ts': CONTAINERS };
    const plugin = pluginBundle(dir, files, 'app.ts', project);
    const transformer = transformerBundle(dir, 'app.ts', project, files, false);

    const left = plugin.mod.leftInstance as () => { side: string };
    const right = plugin.mod.rightInstance as () => { side: string };
    expect(left()).toBeInstanceOf(plugin.mod.LeftImpl);
    expect(right()).toBeInstanceOf(plugin.mod.RightImpl);
    expect(left()).not.toBeInstanceOf(plugin.mod.RightImpl);
    expect(typeof (plugin.mod.empty as { resolve?: unknown }).resolve).toBe('function');

    expect(transformer.error).toBe('');
    expect(transformer.text).toBe(plugin.texts.get('app.ts'));
    const tLeft = transformer.mod.leftInstance as () => { side: string };
    const tRight = transformer.mod.rightInstance as () => { side: string };
    expect(tLeft()).toBeInstanceOf(transformer.mod.LeftImpl);
    expect(tRight()).toBeInstanceOf(transformer.mod.RightImpl);
    expect(typeof (transformer.mod.empty as { resolve?: unknown }).resolve).toBe('function');
  });

  it('T11-P2-default-parent', () => {
    const dir = tempDir('t11-p2-');
    const project = writeTsconfig(dir);
    const parent = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
export interface Logger { log(msg: string): string }
export class ConsoleLogger implements Logger { log(msg: string) { return 'from-parent:' + msg; } }
export const parent = defineBuilderConfig({
  injections: [{ token: useInterface<Logger>(), provider: ConsoleLogger }],
});
`;
    const child = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { parent, type Logger } from './parent';
export class Consumer {
  constructor(private readonly logger: Logger) {}
  run() { return this.logger.log('A'); }
}
export default defineBuilderConfig({
  useContainer: parent,
  injections: [{ token: Consumer }],
});
`;
    const files = { 'parent.ts': parent, 'child.ts': child };
    writeFiles(dir, files);
    chdir(dir);

    const plugin = pluginBundle(dir, files, 'child.ts', project);
    const transformer = transformerBundle(dir, 'child.ts', project, files, true);
    const pluginRun = (plugin.mod.default as { resolve: (token: unknown) => { run: () => string } })
      .resolve(plugin.mod.Consumer).run();
    expect(pluginRun).toBe('from-parent:A');
    expect(transformer.error).toBe('');
    const transformerRun = (transformer.mod.default as { resolve: (token: unknown) => { run: () => string } })
      .resolve(transformer.mod.Consumer).run();
    expect(transformerRun).toBe('from-parent:A');
  });

  it('T11-P3-alias-namespace-property', () => {
    const dir = tempDir('t11-p3-');
    const project = writeTsconfig(dir);
    const app = `
import { useInterface as ui, useProperty } from '@djodjonx/neosyringe';
import * as neo from '@djodjonx/neosyringe';

export class Box { x = 1; }
export interface Svc { n: number }
export class SvcImpl implements Svc { n = 7; }

const key = useProperty(Box, 'x');
const aliasToken = ui<Svc>();
const nsToken = neo.useProperty(Box, 'x');

export const container = defineBuilderConfig({
  injections: [
    { token: key, provider: () => 3 },
    { token: aliasToken, provider: SvcImpl },
  ],
});

export function readKey() { return container.resolve(key); }
export function readSvc() { return container.resolve(aliasToken); }
export function tokens() { return { key, aliasToken, nsToken }; }
`;
    // defineBuilderConfig is used. Import it through the alias file's second binding.
    const source = app.replace(
      "import { useInterface as ui, useProperty } from '@djodjonx/neosyringe';",
      "import { defineBuilderConfig, useInterface as ui, useProperty } from '@djodjonx/neosyringe';",
    );
    const files = { 'app.ts': source };
    writeFiles(dir, files);
    chdir(dir);
    const plugin = pluginBundle(dir, files, 'app.ts', project);
    const transformer = transformerBundle(dir, 'app.ts', project, files, true);
    const pluginText = plugin.texts.get('app.ts') ?? '';
    expect(pluginText).not.toMatch(/useProperty\(|useInterface\(|\bui\s*</);
    expect((plugin.mod.readKey as () => number)()).toBe(3);
    expect((plugin.mod.readSvc as () => object)()).toBeInstanceOf(plugin.mod.SvcImpl);
    const pluginTokens = (plugin.mod.tokens as () => { key: string; nsToken: string })();
    expect(pluginTokens.key).toBe(pluginTokens.nsToken);
    expect(transformer.error).toBe('');
    expect(transformer.text).not.toMatch(/useProperty\(|useInterface\(|\bui\s*</);
    expect((transformer.mod.readKey as () => number)()).toBe(3);
    expect((transformer.mod.readSvc as () => object)()).toBeInstanceOf(transformer.mod.SvcImpl);
    const transformerTokens = (transformer.mod.tokens as () => { key: string; nsToken: string })();
    expect(transformerTokens.key).toBe(transformerTokens.nsToken);
  });

  it('T11-P4-default-class-token', () => {
    const dir = tempDir('t11-p4-');
    const project = writeTsconfig(dir);
    const service = `export default class Service { tag = 'svc'; }\n`;
    const app = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import Service from './service';
export { default as Service } from './service';
export const container = defineBuilderConfig({
  injections: [{ token: Service }],
});
export function take() { return container.resolve(Service); }
`;
    const files = { 'service.ts': service, 'app.ts': app };
    writeFiles(dir, files);
    chdir(dir);
    const plugin = pluginBundle(dir, files, 'app.ts', project);
    const transformer = transformerBundle(dir, 'app.ts', project, files, true);
    const pluginText = plugin.texts.get('app.ts') ?? '';
    expect(pluginText).toContain('__neo_Import_0.default');
    const pluginUses = pluginText.match(/__neo_Import_0\.default/g) ?? [];
    expect(pluginUses.length).toBeGreaterThan(1);
    expect((plugin.mod.take as () => object)()).toBeInstanceOf(plugin.mod.Service);
    expect(transformer.error).toBe('');
    expect(transformer.text).toContain('__neo_Import_0.default');
    const transformerUses = transformer.text.match(/__neo_Import_0\.default/g) ?? [];
    expect(transformerUses.length).toBeGreaterThan(1);
    expect((transformer.mod.take as () => object)()).toBeInstanceOf(transformer.mod.Service);
  });

  it('T11-P5-id-query-windows', () => {
    const dir = tempDir('t11-p5-');
    const project = writeTsconfig(dir);
    chdir(dir);
    const source = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
export interface Marker { id: number }
class MarkerImpl implements Marker { id = 1 }
const token = useInterface<Marker>();
export const container = defineBuilderConfig({
  injections: [{ token: token, provider: MarkerImpl }],
});
export const used = token;
`;
    const plugin = hooks({ project });
    expect(plugin.transformInclude('/abs/a.ts?v=1')).toBe(true);
    expect(plugin.transformInclude('/abs/a.ts?v=2')).toBe(true);
    expect(plugin.transformInclude('C:\\proj\\a.ts')).toBe(true);
    expect(plugin.transformInclude('C:/proj/a.ts')).toBe(true);
    const first = codeOf(plugin.transform(source, '/abs/a.ts?v=1'));
    const second = codeOf(plugin.transform(source, '/abs/a.ts?v=2'));
    const windowsBack = codeOf(plugin.transform(source, 'C:\\proj\\a.ts'));
    const windowsFwd = codeOf(plugin.transform(source, 'C:/proj/a.ts'));
    expect(first).toContain('class NeoContainer');
    const tokenOf = (text: string) => text.match(/Marker_[0-9a-f]{8}/)?.[0];
    expect(tokenOf(second)).toBe(tokenOf(first));
    expect(tokenOf(windowsFwd)).toBe(tokenOf(windowsBack));
    expect(tokenOf(windowsBack)).toMatch(/^Marker_[0-9a-f]{8}$/);
    expect(() => plugin.buildEnd()).not.toThrow();

    const mts = path.join(dir, 'mod.mts');
    expect(() => plugin.transform(source, mts)).toThrow(/\.mts/);
    expect(() => plugin.transform(source, mts)).toThrow(/\.ts/);
    expect(() => plugin.transform(source, mts)).toThrow(/\.tsx/);
    const plain = 'export const n = 1;\n';
    expect(plugin.transform(plain, path.join(dir, 'plain.mts'))).toBeUndefined();
    expect(plugin.transform(plain, path.join(dir, 'plain.cts'))).toBeUndefined();

    writeFileSync(path.join(dir, 'run.ts'), first);
    const options = optionsOf(project);
    const program = ts.createProgram([path.join(dir, 'run.ts')], options);
    emitProgram(program, dir);
    const mod = runJs(dir, 'run.ts');
    expect(mod.used).toBe(tokenOf(first));
    expect(typeof (mod.container as { resolve?: unknown }).resolve).toBe('function');
  });

  it('T11-P6-project-tsconfig', () => {
    const missing = tempDir('t11-p6-missing-');
    chdir(missing);
    const missingDir = process.cwd();
    const plugin = hooks();
    const marker = "import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport const c = defineBuilderConfig({ injections: [] });\n";
    let missingMessage = '';
    try {
      plugin.transform(marker, path.join(missingDir, 'a.ts'));
    } catch (error) {
      missingMessage = error instanceof Error ? error.message : String(error);
    }
    expect(missingMessage).toBe(
      `[NeoSyringe] Could not find tsconfig.json in ${missingDir}. Pass project to select a tsconfig.`,
    );

    const brokenDir = tempDir('t11-p6-broken-');
    chdir(brokenDir);
    const broken = path.join(process.cwd(), 'tsconfig.json');
    writeFileSync(broken, '{');
    const read = ts.readConfigFile(broken, ts.sys.readFile);
    const tsMessage = ts.flattenDiagnosticMessageText(read.error?.messageText ?? '', '\n');
    let brokenMessage = '';
    try {
      hooks().transform(marker, path.join(brokenDir, 'a.ts'));
    } catch (error) {
      brokenMessage = error instanceof Error ? error.message : String(error);
    }
    expect(brokenMessage).toBe(`[NeoSyringe] Could not read ${broken}: ${tsMessage}`);

    const root = tempDir('t11-p6-alias-');
    const boxA = `export default class BoxA { tag = 'from-a'; }\n`;
    const boxB = `export default class BoxB { tag = 'from-b'; }\n`;
    const orphan = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import Box from '@box';
export interface Need { id: string }
export const orphan = defineBuilderConfig({
  injections: [{ token: useInterface<Need>(), provider: Box }],
});
`;
    const app = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import Box from '@box';
export const container = defineBuilderConfig({
  injections: [{ token: Box }],
});
export function tag() { return container.resolve(Box).tag; }
`;
    writeFiles(root, { 'a/box.ts': boxA, 'b/box.ts': boxB, 'app.ts': app, 'orphan.ts': orphan });
    const configA = path.join(root, 'tsconfig.json');
    const configB = path.join(root, 'tsconfig.b.json');
    const compilerOptions = {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'Bundler',
      strict: true,
      noLib: true,
      types: [],
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: '.',
      paths: { ...neoPaths(), '@box': ['./a/box.ts'] },
    };
    writeFileSync(configA, JSON.stringify({ compilerOptions, include: ['*.ts', 'a/**/*.ts', 'b/**/*.ts'] }));
    writeFileSync(configB, JSON.stringify({
      compilerOptions: { ...compilerOptions, paths: { ...neoPaths(), '@box': ['./b/box.ts'] } },
      include: ['*.ts', 'a/**/*.ts', 'b/**/*.ts'],
    }));
    chdir(root);
    const selected = pluginBundle(root, { 'app.ts': app, 'a/box.ts': boxA, 'b/box.ts': boxB }, 'app.ts', configB);
    expect(selected.texts.get('app.ts')).toContain('b/box');
    expect((selected.mod.tag as () => string)()).toBe('from-b');

    const host = ts.createProgram([path.join(root, 'app.ts')], optionsOf(configA));
    const next = neoSyringeTransformer(host, undefined, { project: configB }, { ts });
    const transformerText = next.getSourceFile(path.join(root, 'app.ts'))?.text ?? '';
    expect(transformerText).toContain('b/box');
    const out = path.join(root, 'transformer-out');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'tsconfig.json'), readFileSync(configB, 'utf8'));
    emitProgram(next, out);
    expect((runJs(out, 'app.ts').tag as () => string)()).toBe('from-b');

    const cli = path.join(ROOT, 'packages/cli/dist/index.mjs');
    const elsewhere = tempDir('t11-p6-cwd-');
    const spawned = spawnSync(process.execPath, [cli, '--json', '--project', configB], {
      cwd: elsewhere,
      encoding: 'utf8',
    });
    const report = JSON.parse(spawned.stdout) as { errors?: { message: string }[] };
    const messages = (report.errors ?? []).map((error) => error.message).join('\n');
    expect(messages).toContain('BoxB');
    expect(messages).not.toContain('BoxA');

    const hintDir = tempDir('t11-p6-cli-missing-');
    const hint = spawnSync(process.execPath, [cli, '--json'], {
      cwd: hintDir,
      encoding: 'utf8',
    });
    const hintReport = JSON.parse(hint.stdout) as { fatal?: string };
    expect(hintReport.fatal).toContain('Use --project <path>');
  });

  it('T11-P9-two-projects', () => {
    const root = tempDir('t11-p9-');
    const writeProject = (name: string, paths: Record<string, string[]>, files: Record<string, string>): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFiles(dir, files);
      return writeTsconfig(dir, paths);
    };
    const sourceA = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import OnlyA from '@only-a/box';
export interface Marker { id: number }
class MarkerImpl implements Marker { id = 1 }
export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<Marker>(), provider: MarkerImpl },
    { token: OnlyA },
  ],
});
export function tag() { return container.resolve(OnlyA).tag; }
`;
    const sourceB = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
export const container = defineBuilderConfig({ injections: [] });
`;
    const projectA = writeProject('a', { '@only-a/*': ['./lib/*'] }, {
      'app.ts': sourceA,
      'lib/box.ts': `export default class OnlyA { tag = 'only-a'; }\n`,
    });
    const projectB = writeProject('b', {}, { 'app.ts': sourceB });
    const pluginA = hooks({ project: projectA });
    const pluginB = hooks({ project: projectB });
    const fileA = path.join(root, 'a/app.ts');
    const fileB = path.join(root, 'b/app.ts');
    let thrown = '';
    let first = '';
    let second = '';
    try {
      first = codeOf(pluginA.transform(sourceA, fileA));
      pluginB.transform(sourceB, fileB);
      second = codeOf(pluginA.transform(sourceA, fileA));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe('');
    expect(second).toBe(first);
    expect(second).toContain('lib/box');

    writeFileSync(fileA, first);
    const out = path.join(root, 'a');
    const program = ts.createProgram([fileA], optionsOf(projectA));
    emitProgram(program, out);
    expect((runJs(out, 'app.ts').tag as () => string)()).toBe('only-a');
  });

  it('T11-P12-transformer-root-parity', () => {
    const root = tempDir('t11-p12-');
    const projectDir = path.join(root, 'sub');
    const otherCwd = path.join(root, 'elsewhere');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'export interface Marker { id: number }',
      'class MarkerImpl implements Marker { id = 1 }',
      'const token = useInterface<Marker>();',
      'export const container = defineBuilderConfig({',
      '  injections: [{ token, provider: MarkerImpl }],',
      '});',
      'export const used = token;',
      '',
    ].join('\n');
    writeFiles(projectDir, { 'app.ts': source });
    const configPath = writeTsconfig(projectDir);
    chdir(otherCwd);

    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: ts.sys.readDirectory,
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      getCurrentDirectory: () => process.cwd(),
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (!parsed) throw new Error('tsconfig illisible');
    const entry = parsed.fileNames.find((name) => name.endsWith('/app.ts') || name.endsWith('\\app.ts'));
    if (!entry) throw new Error('app.ts absent du programme');
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const next = neoSyringeTransformer(program, undefined, {}, { ts });
    const transformerText = next.getSourceFile(entry)?.text ?? '';
    const transformerToken = transformerText.match(/Marker_[0-9a-f]{8}/)?.[0];
    const pluginText = codeOf(hooks({ project: configPath }).transform(readFileSync(entry, 'utf8'), entry));
    const pluginToken = pluginText.match(/Marker_[0-9a-f]{8}/)?.[0];
    expect(pluginToken).toMatch(/^Marker_[0-9a-f]{8}$/);
    expect(transformerToken).toBe(pluginToken);
  });

  it('T11-P13-use-site-in-factory', () => {
    const dir = tempDir('t11-p13-');
    const source = [
      "import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';",
      'export interface A { n: number }',
      'class AImpl implements A { n = 4; }',
      'export interface B { n: number }',
      'class BImpl implements B { constructor(public n: number) {} }',
      'export interface Label { text: string }',
      'export class Host { constructor(public secret: string) {} }',
      "export const propertyToken = useProperty<string>(Host, 'secret');",
      'export const container = defineBuilderConfig({',
      '  injections: [',
      '    { token: useInterface<A>(), provider: AImpl },',
      "    { token: useProperty<string>(Host, 'secret'), provider: () => 's3cret' },",
      '    {',
      '      token: useInterface<B>(),',
      '      provider: (k: { resolve(token: unknown): A }) => new BImpl(k.resolve(useInterface<A>()).n),',
      '    },',
      "    { token: useInterface<Label>(), useValue: useProperty<string>(Host, 'secret') },",
      '  ],',
      '});',
      'export function read() {',
      '  const resolved = container.resolve(useInterface<B>());',
      '  const label = container.resolve(useInterface<Label>());',
      '  const secret = container.resolve(propertyToken);',
      '  return { n: resolved.n, same: label === propertyToken, secret };',
      '}',
      '',
    ].join('\n');
    const files = { 'app.ts': source };
    writeFiles(dir, files);
    const project = writeTsconfig(dir);
    const plugin = pluginBundle(dir, files, 'app.ts', project);
    const pluginText = plugin.texts.get('app.ts') ?? '';
    expect(pluginText).not.toMatch(/useInterface\s*[<(]/);
    expect(pluginText).not.toMatch(/useProperty\s*[<(]/);
    expect((plugin.mod.read as () => { n: number; same: boolean; secret: string })()).toEqual({
      n: 4,
      same: true,
      secret: 's3cret',
    });

    const transformer = transformerBundle(dir, 'app.ts', project, files, false);
    expect(transformer.error).toBe('');
    expect(transformer.text).not.toMatch(/useInterface\s*[<(]/);
    expect(transformer.text).not.toMatch(/useProperty\s*[<(]/);
    expect((transformer.mod.read as () => { n: number; same: boolean; secret: string })()).toEqual({
      n: 4,
      same: true,
      secret: 's3cret',
    });
  });

  it('T11-P14-mts-with-import', () => {
    const dir = tempDir('t11-p14-');
    chdir(dir);
    const project = writeTsconfig(dir);
    const plugin = hooks({ project });
    const fsFile = "import { readFileSync } from 'node:fs';\nexport const n = readFileSync;\n";
    const run = (code: string, name: string): { thrown: string; result: unknown } => {
      try {
        return { thrown: '', result: plugin.transform(code, path.join(dir, name)) };
      } catch (error) {
        return { thrown: error instanceof Error ? error.message : String(error), result: undefined };
      }
    };
    const mts = run(fsFile, 'util.mts');
    const cts = run(fsFile, 'util.cts');
    expect(mts.thrown).toBe('');
    expect(mts.result).toBeUndefined();
    expect(cts.thrown).toBe('');
    expect(cts.result).toBeUndefined();

    const marker = [
      "import { useInterface } from '@djodjonx/neosyringe';",
      'export interface A { n: number }',
      'export const token = useInterface<A>();',
      '',
    ].join('\n');
    const markedMts = run(marker, 'mark.mts');
    const markedCts = run(marker, 'mark.cts');
    expect(markedMts.thrown).toMatch(/\.mts/);
    expect(markedMts.thrown).toMatch(/not supported/);
    expect(markedCts.thrown).toMatch(/\.cts/);
    expect(markedCts.thrown).toMatch(/not supported/);
  });

  it('T11-P16-vue-style-id', () => {
    const dir = tempDir('t11-p16-');
    chdir(dir);
    const project = writeTsconfig(dir);
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'export interface Marker { id: number }',
      'class MarkerImpl implements Marker { id = 9; }',
      'export const container = defineBuilderConfig({',
      '  injections: [{ token: useInterface<Marker>(), provider: MarkerImpl }],',
      '});',
      'export function read() { return container.resolve(useInterface<Marker>()).id; }',
      '',
    ].join('\n');
    const id = '/abs/App.vue?vue&type=script&setup=true&lang.ts';
    const plugin = hooks({ project });
    expect(plugin.transformInclude(id)).toBe(true);
    const output = codeOf(plugin.transform(source, id));
    expect(output).not.toMatch(/useInterface\s*[<(]/);
    expect(output).toContain('class NeoContainer');
    plugin.buildEnd();
    writeFileSync(path.join(dir, 'app.ts'), output);
    emitProgram(ts.createProgram([path.join(dir, 'app.ts')], optionsOf(project)), dir);
    expect((runJs(dir, 'app.ts').read as () => number)()).toBe(9);
  });

  it('T11-P17-project-keeps-emit-options', () => {
    const dir = tempDir('t11-p17-');
    const source = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      'export const container = defineBuilderConfig({ injections: [] });',
      '',
    ].join('\n');
    writeFiles(dir, { 'app.ts': source });
    const base = {
      target: 'ES2022',
      module: 'CommonJS',
      moduleResolution: 'Bundler',
      strict: true,
      noLib: true,
      types: [],
      skipLibCheck: true,
      baseUrl: '.',
      paths: neoPaths(),
    };
    const hostConfig = path.join(dir, 'tsconfig.host.json');
    const projectConfig = path.join(dir, 'tsconfig.project.json');
    writeFileSync(hostConfig, JSON.stringify({
      compilerOptions: { ...base, outDir: 'host-out', declaration: true },
      include: ['app.ts'],
    }));
    writeFileSync(projectConfig, JSON.stringify({
      compilerOptions: { ...base, outDir: 'project-out', declaration: false },
      include: ['app.ts'],
    }));
    const hostParsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(hostConfig, ts.sys.readFile).config,
      ts.sys,
      dir,
    );
    const host = ts.createProgram(hostParsed.fileNames, hostParsed.options);
    const next = neoSyringeTransformer(host, undefined, { project: projectConfig }, { ts });
    expect(next.getCompilerOptions().outDir).toBe(host.getCompilerOptions().outDir);
    expect(next.getCompilerOptions().declaration).toBe(host.getCompilerOptions().declaration);
    expect(host.getCompilerOptions().declaration).toBe(true);
  });
});
