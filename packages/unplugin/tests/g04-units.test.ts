import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { graphsForProgram, noteAnalysisBuilt, noteContainersAnalysed, readAnalysisCounters, releaseGraphCache } from '../src/analysisCache';
import { usageErrorsAtBuildEnd } from '../src/buildEndUsages';
import { neoSyringePlugin } from '../src/index';
import { SnapshotCache, classifyWatchChange, isEnvironmentFile } from '../src/invalidation';
import { ProjectSession, optionsFingerprint, type DeclarationStore } from '../src/projectSession';
import { applyWatchChange, closeProjectSession, revalidateSessions, sessionStateKey, trackSourceText, type ProjectSlot, type SessionState } from '../src/session';

/**
 * One named test per export the session work added: ProjectSession and its options, optionsFingerprint,
 * SnapshotCache, classifyWatchChange, isEnvironmentFile, trackSourceText, applyWatchChange,
 * closeProjectSession, revalidateSessions, the session slots of the environments, noteAnalysisBuilt, noteContainersAnalysed, `ProjectSession.scoped` and the `scope` of graphsForProgram. The behaviour seen through
 * the plugin hooks is in g04-session.test.ts.
 */

const ROOT = repoRoot();
const dirs: string[] = [];
const opened: ProjectSession[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  for (const session of opened.splice(0)) session.close();
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function chdir(dir: string): void {
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noLib: true,
  types: [],
  skipLibCheck: true,
};

function open(dir: string, roots: string[], extra: ConstructorParameters<typeof ProjectSession>[3] = {}): ProjectSession {
  const session = new ProjectSession(dir, roots.map((name) => path.join(dir, name)), OPTIONS, extra);
  opened.push(session);
  return session;
}

function sourceNames(program: ts.Program, dir: string): string[] {
  const base = dir.replace(/\\/g, '/');
  return program.getSourceFiles().map((source) => source.fileName).filter((name) => name.startsWith(base)).sort();
}

function blankState(): SessionState {
  return {
    registeredTokens: new Set(),
    usedTokens: new Map(),
    generatedContainerVars: new Set(),
    devtoolsGraphs: new Map(),
    cachedSources: new Map(),
    filesParsed: 0,
    graphsBuilt: 0,
    declarationSources: new Map(),
  };
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'object' && value !== null && 'registeredTokens' in value && 'usedTokens' in value;
}

function pluginState(plugin: object): SessionState {
  const value: unknown = Reflect.get(plugin, sessionStateKey);
  if (!isSessionState(value)) throw new Error('missing session state');
  return value;
}

function callHook(plugin: object, name: string, context: object, args: unknown[]): unknown {
  const hook: unknown = Reflect.get(plugin, name);
  if (typeof hook !== 'function') throw new Error(`hook ${name} missing`);
  return Reflect.apply(hook, context, args);
}

function tsconfig(dir: string, target: string): string {
  const file = path.join(dir, 'tsconfig.json');
  writeFileSync(file, JSON.stringify({
    compilerOptions: {
      target,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noLib: true,
      types: [],
      skipLibCheck: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] },
    },
    include: ['**/*.ts'],
  }));
  return file;
}

const NEO = "import { defineBuilderConfig } from '@djodjonx/neosyringe';";
const CONTAINER = `${NEO}\nclass Alpha {}\nexport const c = defineBuilderConfig({ injections: [{ token: Alpha }] });\n`;

describe('G04 units: ProjectSession', () => {
  it('G04-U1 update stores an overlay only when the text differs from the disk', () => {
    const dir = tempDir('g04-u1-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    const file = path.join(dir, 'a.ts');
    session.update(file, 'export const a = 1;\n');
    expect(session.stats().overlays).toBe(0);
    session.update(file, 'export const a = 2;\n');
    expect(session.stats().overlays).toBe(1);
    session.update(file, 'export const a = 1;\n');
    expect(session.stats().overlays).toBe(0);
  });

  it('G04-U2 snapshot is the same Program until a revision changes', () => {
    const dir = tempDir('g04-u2-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    const first = session.snapshot();
    expect(session.snapshot()).toBe(first);
    expect(session.stats().programsBuilt).toBe(1);
    session.update(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    const second = session.snapshot();
    expect(second).not.toBe(first);
    expect(session.stats().programsBuilt).toBe(2);
  });

  it('G04-U3 the Program reads the overlay, and the disk again once the overlay is dropped', () => {
    const dir = tempDir('g04-u3-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    const file = path.join(dir, 'a.ts');
    session.update(file, 'export const a = 2;\n');
    expect(session.snapshot().getSourceFile(file)?.text).toBe('export const a = 2;\n');
    session.dropOverlay(file);
    expect(session.snapshot().getSourceFile(file)?.text).toBe('export const a = 1;\n');
    expect(session.stats().overlays).toBe(0);
  });

  it('G04-U4 remove drops the overlay, the source and the root, as a deletion of the environment', () => {
    const dir = tempDir('g04-u4-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const session = open(dir, ['a.ts', 'b.ts']);
    const b = path.join(dir, 'b.ts');
    session.update(b, 'export const b = 2;\n');
    expect(sourceNames(session.snapshot(), dir)).toHaveLength(2);
    unlinkSync(b);
    session.remove(b);
    expect(session.has(b)).toBe(false);
    expect(session.stats().overlays).toBe(0);
    expect(sourceNames(session.snapshot(), dir)).toEqual([path.join(dir, 'a.ts').replace(/\\/g, '/')]);
    expect(session.stats().invalidations).toContainEqual({ kind: 'environment', reason: 'delete', count: 1 });
  });

  it('G04-U5 setRoots with the same list changes nothing, another list is an environment change', () => {
    const dir = tempDir('g04-u5-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const session = open(dir, ['a.ts', 'b.ts']);
    const first = session.snapshot();
    session.setRoots([path.join(dir, 'b.ts'), path.join(dir, 'a.ts')]);
    expect(session.snapshot()).toBe(first);
    session.setRoots([path.join(dir, 'a.ts')]);
    const next = session.snapshot();
    expect(next).not.toBe(first);
    expect(sourceNames(next, dir)).toEqual([path.join(dir, 'a.ts').replace(/\\/g, '/')]);
    expect(session.stats().invalidations).toContainEqual({ kind: 'environment', reason: 'roots', count: 1 });
  });

  it('G04-U6 invalidateFiles reads again the named files and keeps the SourceFile of the others', () => {
    const dir = tempDir('g04-u6-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const parsed: string[] = [];
    const session = open(dir, ['a.ts', 'b.ts'], { onParse: (file) => { parsed.push(path.basename(file)); } });
    const first = session.snapshot();
    expect(parsed.sort()).toEqual(['a.ts', 'b.ts']);
    parsed.length = 0;
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    session.invalidateFiles([path.join(dir, 'a.ts')]);
    const second = session.snapshot();
    expect(parsed).toEqual(['a.ts']);
    expect(second.getSourceFile(path.join(dir, 'a.ts'))?.text).toBe('export const a = 2;\n');
    expect(second.getSourceFile(path.join(dir, 'b.ts'))).toBe(first.getSourceFile(path.join(dir, 'b.ts')));
    expect(session.stats().sourcesParsed).toBe(3);
    expect(session.stats().sourcesReused).toBeGreaterThan(0);
  });

  it('G04-U7 invalidateFiles without files reads every file again', () => {
    const dir = tempDir('g04-u7-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const session = open(dir, ['a.ts', 'b.ts']);
    session.snapshot();
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    session.invalidateFiles();
    const next = session.snapshot();
    expect(next.getSourceFile(path.join(dir, 'a.ts'))?.text).toBe('export const a = 2;\n');
    expect(next.getSourceFile(path.join(dir, 'b.ts'))?.text).toBe('export const b = 2;\n');
  });

  it('G04-U8 invalidateEnvironment resolves the imports again', () => {
    const dir = tempDir('g04-u8-');
    writeFiles(dir, { 'app.ts': "import { dep } from './dep';\nexport const v = dep;\n" });
    const session = open(dir, ['app.ts']);
    const dep = path.join(dir, 'dep.ts').replace(/\\/g, '/');
    expect(session.snapshot().getSourceFile(dep)).toBeUndefined();
    writeFiles(dir, { 'dep.ts': 'export const dep = 1;\n' });
    session.invalidateEnvironment('create');
    expect(session.snapshot().getSourceFile(dep)?.text).toBe('export const dep = 1;\n');
    expect(session.stats().invalidations).toContainEqual({ kind: 'environment', reason: 'create', count: 1 });
  });

  it('G04-U9 revalidate sees a disk edit in the import closure and builds no Program when nothing changed', () => {
    const dir = tempDir('g04-u9-');
    writeFiles(dir, {
      'app.ts': "import { dep } from './dep';\nexport const v = dep;\n",
      'dep.ts': 'export const dep = 1;\n',
      'unrelated.ts': 'export const other = 1;\n',
    });
    const session = open(dir, ['app.ts', 'dep.ts', 'unrelated.ts']);
    const first = session.snapshot();
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(false);
    expect(session.snapshot()).toBe(first);
    expect(session.stats().programsBuilt).toBe(1);
    // A file the entry does not reach is not probed: it needs a watcher event.
    writeFileSync(path.join(dir, 'unrelated.ts'), 'export const other = 2;\n');
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(false);
    expect(session.stats().programsBuilt).toBe(1);
    writeFileSync(path.join(dir, 'dep.ts'), 'export const dep = 2;\n');
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(true);
    expect(session.snapshot().getSourceFile(path.join(dir, 'dep.ts'))?.text).toBe('export const dep = 2;\n');
    expect(session.stats().programsBuilt).toBe(2);
    expect(session.stats().invalidations).toContainEqual({ kind: 'files', reason: 'probe', count: 1 });
  });

  it('G04-U10 revalidate does not probe a file that has an overlay', () => {
    const dir = tempDir('g04-u10-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    session.update(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    session.snapshot();
    expect(session.revalidate(path.join(dir, 'a.ts'))).toBe(false);
    expect(session.snapshot().getSourceFile(path.join(dir, 'a.ts'))?.text).toBe('export const a = 2;\n');
  });

  it('G04-U19 revalidate does not count again a file that is already invalidated, nor anything once every file is', () => {
    const dir = tempDir('g04-u19-');
    writeFiles(dir, {
      'app.ts': "import { dep } from './dep';\nimport { two } from './dep2';\nexport const v = [dep, two];\n",
      'dep.ts': 'export const dep = 1;\n',
      'dep2.ts': 'export const two = 1;\n',
    });
    const session = open(dir, ['app.ts', 'dep.ts', 'dep2.ts']);
    session.snapshot();
    writeFileSync(path.join(dir, 'dep.ts'), 'export const dep = 2;\n');
    session.invalidateFiles([path.join(dir, 'dep.ts')]);
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(false);
    writeFileSync(path.join(dir, 'dep2.ts'), 'export const two = 2;\n');
    session.invalidateEnvironment('config');
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(false);
    expect(session.stats().invalidations.map((item) => item.reason).sort()).toEqual(['config', 'update']);
  });

  it('G04-U11 an unchanged SourceFile is kept for the next Program and an edited one is new', () => {
    const dir = tempDir('g04-u11-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const session = open(dir, ['a.ts', 'b.ts']);
    const first = session.snapshot();
    session.update(path.join(dir, 'b.ts'), 'export const b = 2;\n');
    const second = session.snapshot();
    expect(second.getSourceFile(path.join(dir, 'a.ts'))).toBe(first.getSourceFile(path.join(dir, 'a.ts')));
    expect(second.getSourceFile(path.join(dir, 'b.ts'))).not.toBe(first.getSourceFile(path.join(dir, 'b.ts')));
  });

  it('G04-U12 a file outside the roots becomes a root; a file the program already holds adds no Program', () => {
    const dir = tempDir('g04-u12-');
    writeFiles(dir, {
      'app.ts': "import { dep } from './dep';\nexport const v = dep;\n",
      'dep.ts': 'export const dep = 1;\n',
      'loose.ts': 'export const loose = 1;\n',
    });
    const session = open(dir, ['app.ts']);
    session.snapshot();
    session.addRoot(path.join(dir, 'dep.ts'));
    session.snapshot();
    expect(session.stats().programsBuilt).toBe(1);
    session.addRoot(path.join(dir, 'loose.ts'));
    const next = session.snapshot();
    expect(session.stats().programsBuilt).toBe(2);
    expect(next.getSourceFile(path.join(dir, 'loose.ts'))).toBeDefined();
    expect(session.carry().roots).toEqual([path.join(dir, 'dep.ts'), path.join(dir, 'loose.ts')].map((file) => file.replace(/\\/g, '/')));
  });

  it('G04-U13 carry hands the overlays to the session that replaces this one', () => {
    const dir = tempDir('g04-u13-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const file = path.join(dir, 'a.ts');
    const old = open(dir, ['a.ts']);
    old.update(file, 'export const a = 2;\n');
    const next = open(dir, ['a.ts']);
    for (const [name, text] of old.carry().overlays) next.update(name, text);
    expect(next.snapshot().getSourceFile(file)?.text).toBe('export const a = 2;\n');
  });

  it('G04-U14 the manifest of a package that names a tokens manifest is probed', () => {
    const dir = tempDir('g04-u14-');
    writeFiles(dir, {
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', neosyringe: { tokensManifest: './manifest.json' } }),
      'node_modules/pkg/manifest.json': '{"v":1}',
      'node_modules/pkg/index.d.ts': 'export declare const pkg: number;\n',
      'app.ts': "import { pkg } from './node_modules/pkg/index';\nexport const v = pkg;\n",
    });
    const session = open(dir, ['app.ts']);
    session.snapshot();
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(false);
    writeFileSync(path.join(dir, 'node_modules/pkg/manifest.json'), '{"v":2}');
    expect(session.revalidate(path.join(dir, 'app.ts'))).toBe(true);
    expect(session.stats().invalidations).toContainEqual({ kind: 'files', reason: 'probe-manifest', count: 1 });
  });

  it('G04-U15 an entry the program has not read yet probes every file it holds', () => {
    const dir = tempDir('g04-u15-');
    writeFiles(dir, {
      'a.ts': 'export const a = 1;\n',
      'dep.ts': 'export const dep = 1;\n',
      'late.ts': "import { dep } from './dep';\nexport const v = dep;\n",
    });
    const session = open(dir, ['a.ts', 'dep.ts']);
    session.snapshot();
    writeFileSync(path.join(dir, 'dep.ts'), 'export const dep = 2;\n');
    expect(session.revalidate(path.join(dir, 'late.ts'))).toBe(true);
  });

  it('G04-U16 the declaration store keeps declaration sources across sessions, with their text as stamp', () => {
    const dir = tempDir('g04-u16-');
    writeFiles(dir, {
      'widget.d.ts': 'export declare class Widget {}\n',
      'app.ts': "import { Widget } from './widget';\nexport const v = Widget;\n",
    });
    const store = new Map<string, { stamp: string; source: ts.SourceFile }>();
    const first = open(dir, ['app.ts'], { declarationStore: store });
    const widget = path.join(dir, 'widget.d.ts').replace(/\\/g, '/');
    const held = first.snapshot().getSourceFile(widget);
    expect(store.get(widget)?.stamp).toBe('export declare class Widget {}\n');
    first.close();
    expect(store.get(widget)?.source).toBe(held);
    const second = open(dir, ['app.ts'], { declarationStore: store });
    expect(second.snapshot().getSourceFile(widget)).toBe(held);
    writeFileSync(path.join(dir, 'widget.d.ts'), 'export declare class Widget { x: number }\n');
    second.invalidateFiles([path.join(dir, 'widget.d.ts')]);
    expect(second.snapshot().getSourceFile(widget)).not.toBe(held);
    expect(store.get(widget)?.stamp).toContain('x: number');
  });

  it('G04-U17 two sessions with the same relative file names stay apart', () => {
    const one = tempDir('g04-u17a-');
    const two = tempDir('g04-u17b-');
    writeFiles(one, { 'a.ts': 'export const a = 1;\n' });
    writeFiles(two, { 'a.ts': 'export const a = 2;\n' });
    const first = new ProjectSession(one, ['a.ts'], OPTIONS);
    const second = new ProjectSession(two, ['a.ts'], OPTIONS);
    opened.push(first, second);
    first.update('a.ts', 'export const a = 3;\n');
    expect(first.snapshot().getSourceFile(path.join(one, 'a.ts'))?.text).toBe('export const a = 3;\n');
    expect(second.snapshot().getSourceFile(path.join(two, 'a.ts'))?.text).toBe('export const a = 2;\n');
    expect(second.stats().overlays).toBe(0);
  });

  it('G04-U18 close frees the sources and the overlays, and the session is closed', () => {
    const dir = tempDir('g04-u18-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    session.update(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    session.snapshot();
    session.close();
    expect(session.closed).toBe(true);
    expect(session.stats().overlays).toBe(0);
    expect(session.has(path.join(dir, 'a.ts'))).toBe(false);
  });

  it('G04-W1 a closed session refuses update, addRoot, snapshot and revalidate', () => {
    const dir = tempDir('g04-w1-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const session = open(dir, ['a.ts']);
    session.close();
    const file = path.join(dir, 'a.ts');
    expect(() => session.update(file, 'x')).toThrow(/closed/);
    expect(() => session.addRoot(file)).toThrow(/closed/);
    expect(() => session.snapshot()).toThrow(/closed/);
    expect(() => session.revalidate(file)).toThrow(/closed/);
  });
});

describe('G04 units: fingerprint, invalidation, watcher classification', () => {
  it('G04-U20 optionsFingerprint differs when an option differs, and not with the key order', () => {
    const base: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, paths: { a: ['./a'], b: ['./b'] } };
    const reordered: ts.CompilerOptions = { paths: { b: ['./b'], a: ['./a'] }, target: ts.ScriptTarget.ES2022 };
    expect(optionsFingerprint(reordered)).toBe(optionsFingerprint(base));
    expect(optionsFingerprint({ ...base, target: ts.ScriptTarget.ES2020 })).not.toBe(optionsFingerprint(base));
    expect(optionsFingerprint({ ...base, paths: { a: ['./other'], b: ['./b'] } })).not.toBe(optionsFingerprint(base));
  });

  it('G04-U21 SnapshotCache keeps an entry for one object and drops them for another', () => {
    const cache = new SnapshotCache<number>();
    expect(() => cache.getOrCompute('k', () => 1)).toThrow(/begin/);
    const first = {};
    cache.begin(first);
    let computed = 0;
    const compute = () => { computed += 1; return computed; };
    expect(cache.getOrCompute('k', compute)).toBe(1);
    expect(cache.getOrCompute('k', compute)).toBe(1);
    cache.begin(first);
    expect(cache.getOrCompute('k', compute)).toBe(1);
    cache.begin({});
    expect(cache.getOrCompute('k', compute)).toBe(2);
    cache.clear();
    expect(() => cache.getOrCompute('k', compute)).toThrow(/begin/);
  });

  it('G04-U22 isEnvironmentFile names package.json and the tsconfig family only', () => {
    expect(isEnvironmentFile('/p/package.json')).toBe(true);
    expect(isEnvironmentFile('C:\\p\\tsconfig.json')).toBe(true);
    expect(isEnvironmentFile('/p/tsconfig.base.json')).toBe(true);
    expect(isEnvironmentFile('/p/jsconfig.json')).toBe(true);
    expect(isEnvironmentFile('/p/src/app.ts')).toBe(false);
    expect(isEnvironmentFile('/p/tokens-manifest.json')).toBe(false);
  });

  it('G04-U23 classifyWatchChange: the table of events', () => {
    const known = (file: string): boolean => file === '/p/known.ts';
    const classify = (file: string, event: 'create' | 'update' | 'delete') => classifyWatchChange(file, event, { known });
    expect(classify('/p/known.ts', 'update')).toEqual({ kind: 'files', reason: 'update' });
    expect(classify('/p/other.ts', 'update')).toEqual({ kind: 'environment', reason: 'unknown-file' });
    expect(classify('/p/new.ts', 'create')).toEqual({ kind: 'environment', reason: 'create' });
    expect(classify('/p/known.ts', 'delete')).toEqual({ kind: 'environment', reason: 'delete' });
    expect(classify('/p/package.json', 'update')).toEqual({ kind: 'environment', reason: 'package-json' });
    expect(classify('/p/tsconfig.json', 'update')).toEqual({ kind: 'environment', reason: 'config' });
  });
});

describe('G04 units: plugin state, watcher, close, analysis cache', () => {
  it('G04-U30 trackSourceText keeps a differing text before the session exists, and hands it to the session', () => {
    const dir = tempDir('g04-u30-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const file = path.join(dir, 'a.ts');
    const state = blankState();
    trackSourceText(state, dir, file, 'export const a = 1;\n');
    expect(state.pendingOverlays?.size).toBe(0);
    trackSourceText(state, dir, file, 'export const a = 2;\n');
    expect(state.pendingOverlays?.get(file)).toBe('export const a = 2;\n');
    const session = open(dir, ['a.ts']);
    state.project = session;
    trackSourceText(state, dir, file, 'export const a = 3;\n');
    expect(session.stats().overlays).toBe(1);
  });

  it('G04-U31 applyWatchChange: an edit of a known file invalidates files, a creation the environment', () => {
    const dir = tempDir('g04-u31-');
    const config = tsconfig(dir, 'ES2022');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const state = blankState();
    const file = path.join(dir, 'a.ts');
    const session = open(dir, ['a.ts']);
    state.project = session;
    session.update(file, 'export const a = 2;\n');
    session.snapshot();
    applyWatchChange(state, file, 'update', dir, config);
    expect(session.stats().overlays).toBe(0);
    expect(session.stats().invalidations).toContainEqual({ kind: 'files', reason: 'update', count: 1 });
    writeFiles(dir, { 'b.ts': 'export const b = 1;\n' });
    applyWatchChange(state, path.join(dir, 'b.ts'), 'create', dir, config);
    expect(session.stats().invalidations).toContainEqual({ kind: 'environment', reason: 'create', count: 1 });
    // the roots were recomputed from the tsconfig: b.ts is one now
    expect(sourceNames(session.snapshot(), dir)).toContain(path.join(dir, 'b.ts').replace(/\\/g, '/'));
    applyWatchChange(state, path.join(dir, 'package.json'), 'update', dir, config);
    expect(session.stats().invalidations).toContainEqual({ kind: 'environment', reason: 'package-json', count: 1 });
    unlinkSync(path.join(dir, 'b.ts'));
    applyWatchChange(state, path.join(dir, 'b.ts'), 'delete', dir, config);
    expect(session.has(path.join(dir, 'b.ts'))).toBe(false);
    expect(sourceNames(session.snapshot(), dir)).not.toContain(path.join(dir, 'b.ts').replace(/\\/g, '/'));
  });

  it('G04-U32 applyWatchChange without a session drops the pending overlay of the file', () => {
    const state = blankState();
    state.pendingOverlays = new Map([['/p/a.ts', 'x']]);
    applyWatchChange(state, '/p/a.ts', 'update', '/p', undefined);
    expect(state.pendingOverlays.has('/p/a.ts')).toBe(false);
  });

  it('G04-U33 closeProjectSession frees the session, the pending texts, the program and the graphs', () => {
    const dir = tempDir('g04-u33-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const state = blankState();
    const session = open(dir, ['a.ts']);
    state.project = session;
    state.projectKey = 'key';
    state.previousProgram = session.snapshot();
    state.pendingOverlays = new Map([['x', 'y']]);
    state.declarationSources.set('lib.d.ts', { stamp: '', source: ts.createSourceFile('lib.d.ts', '', ts.ScriptTarget.ES2022) });
    state.graphs = [];
    closeProjectSession(state, 'keep');
    expect(session.closed).toBe(true);
    expect(state.project).toBeUndefined();
    expect(state.projectKey).toBeUndefined();
    expect(state.previousProgram).toBeUndefined();
    expect(state.pendingOverlays.size).toBe(0);
    expect(state.graphs).toBeUndefined();
    expect(state.declarationSources.size).toBe(1);
    closeProjectSession(state, 'free');
    expect(state.declarationSources.size).toBe(0);
  });

  it('G04-U34 the plugin replaces the session when a compiler option changes and closes the old one', () => {
    const dir = tempDir('g04-u34-');
    chdir(dir);
    const config = tsconfig(dir, 'ES2022');
    writeFiles(dir, { 'app.ts': CONTAINER });
    const plugin = neoSyringePlugin.vite({ project: config });
    const app = path.join(dir, 'app.ts');
    callHook(plugin, 'transform', {}, [CONTAINER, app]);
    const state = pluginState(plugin);
    const before = state.project;
    expect(before?.closed).toBe(false);
    callHook(plugin, 'transform', {}, [CONTAINER, app]);
    expect(state.project).toBe(before);
    tsconfig(dir, 'ES2020');
    callHook(plugin, 'transform', {}, [CONTAINER, app]);
    expect(state.project).not.toBe(before);
    expect(before?.closed).toBe(true);
    expect(state.project?.closed).toBe(false);
    expect(state.previousProgram?.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2020);
    callHook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
    expect(state.project).toBeUndefined();
  });

  it('G04-U35 a transform on an unchanged project builds no Program, and buildEnd uses the same one', () => {
    const dir = tempDir('g04-u35-');
    chdir(dir);
    const config = tsconfig(dir, 'ES2022');
    const usage = "import { c } from './c';\nexport const value = c.resolve(Object);\n";
    writeFiles(dir, { 'c.ts': CONTAINER, 'u.ts': usage });
    const plugin = neoSyringePlugin.vite({ project: config });
    const state = pluginState(plugin);
    callHook(plugin, 'buildStart', { meta: { watchMode: true } }, [{}]);
    callHook(plugin, 'transform', {}, [CONTAINER, path.join(dir, 'c.ts')]);
    callHook(plugin, 'transform', {}, [usage, path.join(dir, 'u.ts')]);
    const built = state.project?.stats().programsBuilt;
    expect(built).toBe(1);
    callHook(plugin, 'transform', {}, [CONTAINER, path.join(dir, 'c.ts')]);
    expect(state.project?.stats().programsBuilt).toBe(1);
    const program = state.previousProgram;
    try {
      callHook(plugin, 'buildEnd', {}, []);
    } catch {
      // the usage `c.resolve(Object)` is reported; this test is about the Program
    }
    expect(state.project?.stats().programsBuilt).toBe(1);
    expect(state.project?.snapshot()).toBe(program);
  });

  it('G04-U36 usageErrorsAtBuildEnd without a session reads the texts through a short-lived session', () => {
    const dir = tempDir('g04-u36-');
    const config = tsconfig(dir, 'ES2022');
    const ts1 = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(ts1.config, ts.sys, dir, undefined, config);
    const state = blankState();
    state.resolved = { root: dir, options: parsed.options, configPath: config };
    const container = path.join(dir, 'c.ts');
    const usage = path.join(dir, 'u.ts');
    writeFiles(dir, { 'c.ts': CONTAINER, 'u.ts': 'export const v = 1;\n' });
    const texts = new Map([[container, CONTAINER], [usage, "import { c } from './c';\nclass Missing {}\nexport const v = c.resolve(Missing);\n"]]);
    const report = usageErrorsAtBuildEnd(texts, state, 'strict');
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatch(/u\.ts:3:/);
    expect(state.project).toBeUndefined();
  });

  it('G04-U37 graphsForProgram with a scope analyses a Program once and counts the graphs of the file', () => {
    const dir = tempDir('g04-u37-');
    chdir(dir);
    writeFiles(dir, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: {} }, include: [] }),
      'a.ts': CONTAINER.replace('Alpha', 'Alpha'),
      'b.ts': CONTAINER.replace(/Alpha/g, 'Beta'),
    });
    const paths = { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] };
    const session = new ProjectSession(dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')], { ...OPTIONS, baseUrl: dir, paths });
    opened.push(session);
    const state = blankState();
    const a = path.join(dir, 'a.ts').replace(/\\/g, '/');
    const b = path.join(dir, 'b.ts').replace(/\\/g, '/');
    TSContext.runWithProjectRoot(dir, () => {
      const program = session.snapshot();
      const build = () => new Analyzer(program).extractAll();
      const first = graphsForProgram(state, build, undefined, { program, file: a });
      expect(first).toHaveLength(1);
      expect(first[0]?.sourceFileName?.replace(/\\/g, '/')).toBe(a);
      expect(state.analysesBuilt).toBe(1);
      // The analysis collected the two containers of this Program, and the file got its own.
      expect(state.containersAnalysed).toBe(2);
      expect(readAnalysisCounters(state).graphsBuilt).toBe(1);
      const again = graphsForProgram(state, build, undefined, { program, file: a });
      expect(again[0]).not.toBe(first[0]);
      expect(state.analysesBuilt).toBe(1);
      expect(state.containersAnalysed).toBe(2);
      expect(readAnalysisCounters(state).graphsBuilt).toBe(2);
      expect(graphsForProgram(state, build, undefined, { program, file: b })[0]?.sourceFileName?.replace(/\\/g, '/')).toBe(b);
      expect(state.analysesBuilt).toBe(1);
      session.update(a, `${CONTAINER}\n`);
      const next = session.snapshot();
      graphsForProgram(state, () => new Analyzer(next).extractAll(), undefined, { program: next, file: a });
      expect(state.analysesBuilt).toBe(2);
      releaseGraphCache(state);
      graphsForProgram(state, () => new Analyzer(next).extractAll(), undefined, { program: next, file: a });
      expect(state.analysesBuilt).toBe(3);
    });
  });

  it('G04-U38 noteAnalysisBuilt counts from nothing', () => {
    const state = blankState();
    noteAnalysisBuilt(state);
    noteAnalysisBuilt(state);
    expect(state.analysesBuilt).toBe(2);
  });
  it('G04-U39 scoped lists the files the entry imports and no other project file', () => {
    const dir = tempDir('g04-u39-');
    writeFiles(dir, {
      'app.ts': "import { dep } from './dep';\nexport const v = dep;\n",
      'dep.ts': 'export const dep = 1;\n',
      'unrelated.ts': 'export const other = 1;\n',
    });
    const session = open(dir, ['app.ts', 'dep.ts', 'unrelated.ts']);
    const program = session.snapshot();
    const view = session.scoped(path.join(dir, 'app.ts'));
    expect(sourceNames(view, dir).map((name) => path.basename(name))).toEqual(['app.ts', 'dep.ts']);
    // The checker is the Program's own: the whole project still resolves types.
    expect(view.getTypeChecker()).toBe(program.getTypeChecker());
    expect(sourceNames(program, dir)).toHaveLength(3);
    // Same revision and entry, same object. A new revision, a new view.
    expect(session.scoped(path.join(dir, 'app.ts'))).toBe(view);
    session.update(path.join(dir, 'dep.ts'), 'export const dep = 2;\n');
    const next = session.scoped(path.join(dir, 'app.ts'));
    expect(next).not.toBe(view);
    expect(next.getSourceFile(path.join(dir, 'dep.ts'))?.text).toBe('export const dep = 2;\n');
    // Another entry, another view.
    const other = session.scoped(path.join(dir, 'unrelated.ts'));
    expect(sourceNames(other, dir).map((name) => path.basename(name))).toEqual(['unrelated.ts']);
  });

  it('G04-U40 noteContainersAnalysed counts from nothing', () => {
    const state = blankState();
    noteContainersAnalysed(state, 3);
    noteContainersAnalysed(state, 4);
    expect(state.containersAnalysed).toBe(7);
  });

  it('G04-U41 graphsForProgram keeps the analysis of the last scope Program only', () => {
    const dir = tempDir('g04-u41-');
    chdir(dir);
    writeFiles(dir, {
      'a.ts': CONTAINER,
      'b.ts': CONTAINER.replace(/Alpha/g, 'Beta'),
    });
    const paths = { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] };
    const session = new ProjectSession(dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')], { ...OPTIONS, baseUrl: dir, paths });
    opened.push(session);
    const state = blankState();
    const a = path.join(dir, 'a.ts').replace(/\\/g, '/');
    const b = path.join(dir, 'b.ts').replace(/\\/g, '/');
    TSContext.runWithProjectRoot(dir, () => {
      const viewA = session.scoped(a);
      const viewB = session.scoped(b);
      const run = (view: ts.Program, file: string) =>
        graphsForProgram(state, () => new Analyzer(view).extractAll(), undefined, { program: view, file });
      // Each view lists one container: an analysis collects one.
      expect(run(viewA, a)).toHaveLength(1);
      expect(state.analysesBuilt).toBe(1);
      expect(state.containersAnalysed).toBe(1);
      expect(run(viewB, b)).toHaveLength(1);
      expect(state.analysesBuilt).toBe(2);
      expect(state.containersAnalysed).toBe(2);
      // A is analysed again: B's analysis replaced it, nothing keeps the analyses of every file.
      run(viewA, a);
      expect(state.analysesBuilt).toBe(3);
    });
  });
  it('G04-U42 graphsForProgram without a scope counts the containers its analysis collected', () => {
    const dir = tempDir('g04-u42-');
    chdir(dir);
    writeFiles(dir, {
      'a.ts': CONTAINER,
      'b.ts': CONTAINER.replace(/Alpha/g, 'Beta'),
    });
    const paths = { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] };
    const session = new ProjectSession(dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')], { ...OPTIONS, baseUrl: dir, paths });
    opened.push(session);
    const state = blankState();
    TSContext.runWithProjectRoot(dir, () => {
      const program = session.snapshot();
      graphsForProgram(state, () => new Analyzer(program).extractAll(), undefined);
      expect(state.analysesBuilt).toBe(1);
      expect(state.containersAnalysed).toBe(2);
    });
  });
});

describe('G04 units: environments, roots mode, declaration probe', () => {
  function slot(dir: string, session: ProjectSession, roots: ProjectSlot['roots']): ProjectSlot {
    return { key: 'k', session, config: { root: dir, options: OPTIONS, configPath: path.join(dir, 'tsconfig.json') }, roots };
  }

  it('G04-U43 each environment has its own session: alternating them builds no Program and closes nothing', () => {
    const dir = tempDir('g04-u43-');
    chdir(dir);
    const config = tsconfig(dir, 'ES2022');
    writeFiles(dir, { 'app.ts': CONTAINER, 'x.ts': 'export const x = 1;\n' });
    const plugin = neoSyringePlugin.vite({ project: config });
    const state = pluginState(plugin);
    const client = { environment: { name: 'client' } };
    const server = { environment: { name: 'ssr' } };
    const app = path.join(dir, 'app.ts');
    // A text of x.ts that is not the disk's, given in the client environment only.
    callHook(plugin, 'transform', client, ['export const x = 2;\n', path.join(dir, 'x.ts')]);
    callHook(plugin, 'transform', client, [CONTAINER, app]);
    callHook(plugin, 'transform', server, [CONTAINER, app]);
    const clientSlot = state.projects?.get('client');
    const serverSlot = state.projects?.get('ssr');
    expect(clientSlot).toBeDefined();
    expect(serverSlot).toBeDefined();
    expect(clientSlot?.session).not.toBe(serverSlot?.session);
    const built = [clientSlot?.session.stats().programsBuilt, serverSlot?.session.stats().programsBuilt];
    for (let round = 0; round < 3; round += 1) {
      callHook(plugin, 'transform', client, [CONTAINER, app]);
      callHook(plugin, 'transform', server, [CONTAINER, app]);
    }
    expect([clientSlot?.session.stats().programsBuilt, serverSlot?.session.stats().programsBuilt]).toEqual(built);
    expect(state.projects?.get('client')).toBe(clientSlot);
    expect(state.projects?.get('ssr')).toBe(serverSlot);
    expect(clientSlot?.session.closed).toBe(false);
    expect(serverSlot?.session.closed).toBe(false);
    // The overlay stayed in its own environment.
    expect(clientSlot?.session.stats().overlays).toBe(1);
    expect(serverSlot?.session.stats().overlays).toBe(0);
    callHook(plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
    expect(clientSlot?.session.closed).toBe(true);
    expect(serverSlot?.session.closed).toBe(true);
  });

  it('G04-U44 a watcher event recomputes the roots of a session that reads every root, not of one that holds unlisted files', () => {
    const dir = tempDir('g04-u44-');
    const config = tsconfig(dir, 'ES2022');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
    const entryOnly = open(dir, []);
    entryOnly.addRoot(path.join(dir, 'a.ts'));
    const everything = open(dir, []);
    const state = blankState();
    state.projects = new Map([['entry', slot(dir, entryOnly, 'entry')], ['all', slot(dir, everything, 'all')]]);
    applyWatchChange(state, path.join(dir, 'c.ts'), 'create', dir, config);
    // The tsconfig lists a.ts and b.ts: the session in `all` mode holds them now, the other still holds a.ts alone.
    expect(everything.has(path.join(dir, 'b.ts'))).toBe(true);
    expect(entryOnly.has(path.join(dir, 'b.ts'))).toBe(false);
    expect(entryOnly.has(path.join(dir, 'a.ts'))).toBe(true);
  });

  it('G04-U45 a text goes to the session of its environment, and a build start revalidates every session', () => {
    const dir = tempDir('g04-u45-');
    writeFiles(dir, { 'a.ts': 'export const a = 1;\n' });
    const file = path.join(dir, 'a.ts');
    const client = open(dir, ['a.ts']);
    const server = open(dir, ['a.ts']);
    const state = blankState();
    // Before an environment has a session its texts wait apart from the others.
    trackSourceText(state, dir, file, 'export const a = 3;\n', 'ssr');
    expect(state.environmentOverlays?.get('ssr')?.get(file)).toBe('export const a = 3;\n');
    expect(state.pendingOverlays?.has(file)).toBeFalsy();
    state.projects = new Map([['client', slot(dir, client, 'all')], ['ssr', slot(dir, server, 'all')]]);
    trackSourceText(state, dir, file, 'export const a = 2;\n', 'ssr');
    expect(server.stats().overlays).toBe(1);
    expect(client.stats().overlays).toBe(0);
    revalidateSessions(state);
    for (const session of [client, server]) {
      expect(session.stats().invalidations).toContainEqual({ kind: 'files', reason: 'build-start', count: 1 });
    }
  });

  it('G04-U46 revalidate reads again an imported project declaration file', () => {
    const dir = tempDir('g04-u46-');
    const declared = (parameters: string) => `export declare class Dep { constructor(${parameters}); }\n`;
    writeFiles(dir, { 'app.ts': "import { Dep } from './types';\nexport const d: Dep = new Dep();\n", 'types.d.ts': declared('') });
    const store: DeclarationStore = new Map();
    const session = open(dir, ['app.ts'], { declarationStore: store });
    const app = path.join(dir, 'app.ts');
    const errors = (): number => {
      const program = session.snapshot();
      return program.getSemanticDiagnostics(program.getSourceFile(app)).length;
    };
    expect(errors()).toBe(0);
    expect(session.revalidate(app)).toBe(false);
    writeFileSync(path.join(dir, 'types.d.ts'), declared('count: number'));
    expect(session.revalidate(app)).toBe(true);
    expect(errors()).toBe(1);
  });

  it('G04-U47 revalidate reads again a global declaration root the entry does not import', () => {
    const dir = tempDir('g04-u47-');
    writeFiles(dir, { 'app.ts': 'export const v: string = make();\n', 'env.d.ts': 'declare function make(): string;\n' });
    const store: DeclarationStore = new Map();
    const session = open(dir, ['app.ts', 'env.d.ts'], { declarationStore: store });
    const app = path.join(dir, 'app.ts');
    const errors = (): number => {
      const program = session.snapshot();
      return program.getSemanticDiagnostics(program.getSourceFile(app)).length;
    };
    expect(errors()).toBe(0);
    writeFileSync(path.join(dir, 'env.d.ts'), 'declare function make(): number;\n');
    expect(session.revalidate(app)).toBe(true);
    expect(errors()).toBe(1);
  });
});
