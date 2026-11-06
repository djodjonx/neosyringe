import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { HashUtils } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { configChainTexts, readAnalysisCounters } from '../src/analysisCache';
import { usageErrorsAtBuildEnd } from '../src/buildEndUsages';
import { neoSyringePlugin } from '../src/index';
import { runCompilationSession, sessionStateKey, type SessionState } from '../src/session';

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

function compilerOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    baseUrl: '.',
    paths: {
      '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
    },
    ...extra,
  };
}

function writeTsconfig(dir: string, options: Record<string, unknown> = {}, extendsPath?: string): string {
  const file = path.join(dir, 'tsconfig.json');
  const body: Record<string, unknown> = {
    compilerOptions: compilerOptions(options),
    include: ['**/*.ts'],
  };
  if (extendsPath) body.extends = extendsPath;
  writeFileSync(file, JSON.stringify(body));
  return file;
}

type PluginHook = {
  transform: (code: string, id: string) => string | { code?: string; map?: unknown } | null | undefined;
  buildEnd: () => void;
  watchChange: (id: string, change: { event: 'create' | 'update' | 'delete' }) => void;
} & { [sessionStateKey]: SessionState };

function hooks(project: string): PluginHook {
  return neoSyringePlugin.vite({ project }) as unknown as PluginHook;
}

function pluginState(plugin: PluginHook): SessionState {
  return plugin[sessionStateKey];
}

function codeOf(result: string | { code?: string } | null | undefined, fallback: string): string {
  if (typeof result === 'string') return result;
  if (result && typeof result.code === 'string') return result.code;
  return fallback;
}

function mapOf(result: string | { map?: unknown } | null | undefined): unknown {
  if (!result || typeof result === 'string') return null;
  return result.map ?? null;
}

function transformFile(plugin: PluginHook, file: string): string {
  const source = readFileSync(file, 'utf8');
  return codeOf(plugin.transform(source, file), source);
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

function sessionFull(dir: string, file: string, state: SessionState) {
  const source = readFileSync(file, 'utf8');
  return runCompilationSession({
    code: source,
    id: file,
    project: path.join(dir, 'tsconfig.json'),
    cwd: dir,
    emitDebugHelpers: false,
    testOverrides: false,
    devtools: false,
    state,
    errorPrefix: '[neosyringe-plugin]',
  });
}

function session(dir: string, file: string, state: SessionState): string {
  return sessionFull(dir, file, state).code;
}

function storeHostGraphs(dir: string, file: string, state: SessionState): ts.Program {
  const config = path.join(dir, 'tsconfig.json');
  const read = ts.readConfigFile(config, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, config);
  const host = ts.createCompilerHost(parsed.options);
  const program = ts.createProgram([file], parsed.options, host);
  runCompilationSession({
    code: readFileSync(file, 'utf8'),
    id: file,
    cwd: dir,
    emitDebugHelpers: false,
    testOverrides: false,
    devtools: false,
    state,
    errorPrefix: '[neosyringe-transformer]',
    hostProgram: program,
    hostSource: program.getSourceFile(file),
  });
  return program;
}

function factorySources(state: SessionState): string[] {
  const texts: string[] = [];
  for (const graph of state.graphs ?? []) {
    for (const node of graph.nodes.values()) {
      if (node.service.factorySource !== undefined) texts.push(node.service.factorySource);
    }
    for (const list of graph.multiNodes?.values() ?? []) {
      for (const node of list) {
        if (node.service.factorySource !== undefined) texts.push(node.service.factorySource);
      }
    }
  }
  return texts;
}

function executeContainer(code: string): {
  left: { mid: { root: { id: number } } };
  right: { mid: { root: { id: number } } };
} {
  const runtime = require(path.join(ROOT, 'packages/neosyringe/dist/index.cjs')) as Record<string, unknown>;
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exportsObject: Record<string, unknown> = {};
  const run = new Function('exports', 'require', js) as (
    exportsObject: Record<string, unknown>,
    req: (id: string) => unknown,
  ) => void;
  run(exportsObject, (id: string) => {
    if (id === '@djodjonx/neosyringe') return runtime;
    throw new Error(`module inattendu: ${id}`);
  });
  const container = exportsObject.c as { resolve: (token: unknown) => { mid: { root: { id: number } } } };
  const Leaf = exportsObject.Leaf;
  return { left: container.resolve(Leaf), right: container.resolve(Leaf) };
}

const APP = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Dep, Extra } from './dep';
class App { constructor(public dep: Dep) {} }
export const c = defineBuilderConfig({
  injections: [
    { token: Extra },
    { token: Dep },
    { token: App },
  ],
});
`;

const DEP_PLAIN = `
export class Extra {}
export class Dep { constructor() {} }
`;

const DEP_WITH_EXTRA = `
export class Extra {}
export class Dep { constructor(public extra: Extra) {} }
`;

describe('T18 cache invalidation', () => {
  it('T18-A01 constructor change in an imported file changes generated code', () => {
    const dir = tempDir('t18-a01-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP, 'dep.ts': DEP_PLAIN });
    const plugin = hooks(path.join(dir, 'tsconfig.json'));
    const first = transformFile(plugin, path.join(dir, 'app.ts'));
    writeFileSync(path.join(dir, 'dep.ts'), DEP_WITH_EXTRA);
    const second = transformFile(plugin, path.join(dir, 'app.ts'));
    expect(first).toContain('new Dep()');
    expect(second).toContain('new Dep(');
    expect(second).not.toContain('new Dep()');
    expect(second).toContain('Extra');
  });

  it('T18-A01b host graph is not mutated by a second transform', () => {
    const dir = tempDir('t18-a01b-');
    const config = writeTsconfig(dir);
    const file = path.join(dir, 'app.ts');
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'export interface IPort { id: number }',
      'class Impl implements IPort { id = 1 }',
      'export const c = defineBuilderConfig({',
      '  injections: [',
      "    { token: useInterface<IPort>(), useFactory: true, dependencies: [], provider: () => useInterface<IPort>() },",
      '  ],',
      '});',
      '',
    ].join('\n');
    writeFileSync(file, source);
    const read = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, config);
    const host = ts.createCompilerHost(parsed.options);
    const program = ts.createProgram([file], parsed.options, host);
    const state = blankState();
    const input = {
      code: source,
      id: file,
      cwd: dir,
      emitDebugHelpers: false,
      testOverrides: false,
      devtools: false,
      state,
      errorPrefix: '[neosyringe-transformer]',
      hostProgram: program,
      hostSource: program.getSourceFile(file),
    };
    const first = runCompilationSession(input);
    const second = runCompilationSession(input);
    expect(second.code).toBe(first.code);
    expect(first.code).toContain('() => "IPort_');
    const stored = factorySources(state).join('\n');
    expect(stored).toContain('useInterface<IPort>');
  });

  it('T18-A02a tsconfig paths change the rebuilt container', () => {
    const dir = tempDir('t18-a02a-');
    chdir(dir);
    writeFiles(dir, {
      'dep-a.ts': DEP_PLAIN,
      'dep-b.ts': DEP_WITH_EXTRA,
      'app.ts': APP.replace("from './dep'", "from '@app/dep'"),
    });
    const config = writeTsconfig(dir, { paths: { ...compilerOptions().paths as Record<string, string[]>, '@app/dep': ['./dep-a.ts'] } });
    const plugin = hooks(config);
    const app = path.join(dir, 'app.ts');
    const first = transformFile(plugin, app);
    const current = JSON.parse(readFileSync(config, 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
    current.compilerOptions.paths['@app/dep'] = ['./dep-b.ts'];
    writeFileSync(config, JSON.stringify(current));
    const second = transformFile(plugin, app);
    expect(first).toContain('new Dep()');
    expect(second).not.toContain('new Dep()');
    expect(second).toContain('Extra');
  });

  it('T18-A02b token manifest change is emitted on the next transform', () => {
    const dir = tempDir('t18-a02b-');
    chdir(dir);
    const descriptorA = 'v1|named|pkg/@acme/unit/dist/user.d.ts|User|';
    const descriptorB = 'v1|named|pkg/@acme/unit/dist/user.d.ts|User|x';
    const keyA = `User_${HashUtils.hashDescriptor(descriptorA)}`;
    const keyB = `User_${HashUtils.hashDescriptor(descriptorB)}`;
    const pkg = path.join(dir, 'node_modules/@acme/unit');
    writeFiles(dir, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: compilerOptions({ noLib: false, types: undefined }),
        include: ['app.ts'],
      }),
      'app.ts': `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        import type { User } from './node_modules/@acme/unit/dist/user';
        class Impl implements User { id = 1 }
        export const c = defineBuilderConfig({
          injections: [{ token: useInterface<User>(), provider: Impl }],
        });
      `,
    });
    writeUnit(pkg, descriptorA, keyA);
    const plugin = hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    const first = transformFile(plugin, app);
    writeUnit(pkg, descriptorB, keyB);
    const second = transformFile(plugin, app);
    // Guard of the real flow: each transform emits the manifest key read for that call.
    expect(first).toContain(keyA);
    expect(second).toContain(keyB);
    expect(second).not.toContain(keyA);
  });

  it('T18-A02c extends chain change invalidates', () => {
    const dir = tempDir('t18-a02c-');
    chdir(dir);
    writeFiles(dir, {
      'dep-a.ts': DEP_PLAIN,
      'dep-b.ts': DEP_WITH_EXTRA,
      'app.ts': APP.replace("from './dep'", "from '@app/dep'"),
      'base.json': JSON.stringify({
        compilerOptions: compilerOptions({
          paths: {
            ...(compilerOptions().paths as Record<string, string[]>),
            '@app/dep': ['./dep-a.ts'],
          },
        }),
      }),
    });
    const config = path.join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ extends: './base.json', include: ['**/*.ts'] }));
    const plugin = hooks(config);
    const app = path.join(dir, 'app.ts');
    const first = transformFile(plugin, app);
    const basePath = path.join(dir, 'base.json');
    const base = JSON.parse(readFileSync(basePath, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    base.compilerOptions.paths['@app/dep'] = ['./dep-b.ts'];
    writeFileSync(basePath, JSON.stringify(base));
    const second = transformFile(plugin, app);
    expect(first).toContain('new Dep()');
    expect(second).not.toContain('new Dep()');
    expect(second).toContain('Extra');
  });

  it('T18-A02d same size same mtime tsconfig edit invalidates', () => {
    const dir = tempDir('t18-a02d-');
    chdir(dir);
    writeFiles(dir, {
      'dep-a.ts': DEP_PLAIN,
      'dep-b.ts': DEP_WITH_EXTRA,
      'app.ts': APP.replace("from './dep'", "from '@app/dep'"),
    });
    const config = writeTsconfig(dir, {
      paths: { ...compilerOptions().paths as Record<string, string[]>, '@app/dep': ['./dep-a.ts'] },
    });
    const plugin = hooks(config);
    const app = path.join(dir, 'app.ts');
    const first = transformFile(plugin, app);
    const frozen = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(config, frozen, frozen);
    const warmed = transformFile(plugin, app);
    expect(warmed).toContain('new Dep()');
    const before = statSync(config);
    const json = JSON.parse(readFileSync(config, 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
    json.compilerOptions.paths['@app/dep'] = ['./dep-b.ts'];
    const next = JSON.stringify(json);
    expect(Buffer.byteLength(next)).toBe(before.size);
    writeFileSync(config, next);
    utimesSync(config, before.atime, before.mtime);
    expect(statSync(config).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(config).size).toBe(before.size);
    const second = transformFile(plugin, app);
    expect(first).toContain('new Dep()');
    expect(second).not.toContain('new Dep()');
    expect(second).toContain('Extra');
  });

  it('T18-A02f warm transform reads the tsconfig chain once', () => {
    const dir = tempDir('t18-a02f-');
    chdir(dir);
    const config = writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP, 'dep.ts': DEP_PLAIN });
    const plugin = hooks(config);
    const app = path.join(dir, 'app.ts');
    transformFile(plugin, app);
    const baseline = countTsconfigReads(() => { configChainTexts(config); });
    const warm = countTsconfigReads(() => { transformFile(plugin, app); });
    expect(warm).toBe(baseline);
  });

  it('T18-A02g config chain does not scan include directories', () => {
    const dir = tempDir('t18-a02g-');
    const config = writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP, 'dep.ts': DEP_PLAIN });
    const original = ts.sys.readDirectory;
    let scans = 0;
    ts.sys.readDirectory = (...args) => {
      scans += 1;
      return original.apply(ts.sys, args);
    };
    try {
      configChainTexts(config);
    } finally {
      ts.sys.readDirectory = original;
    }
    expect(scans).toBe(0);
  });

  it('T18-A03 two plugin instances keep their own caches', () => {
    const dir = tempDir('t18-a03-');
    writeTsconfig(dir);
    const app = path.join(dir, 'app.ts');
    writeFileSync(app, containerSource('Alpha'));
    const project = path.join(dir, 'tsconfig.json');
    const pluginA = hooks(project);
    const pluginB = hooks(project);
    const firstA = transformFile(pluginA, app);
    const firstB = transformFile(pluginB, app);
    expect(firstA).toContain('new Alpha(');
    expect(firstB).toBe(firstA);
    const parsedA = readAnalysisCounters(pluginState(pluginA)).filesParsed;
    const parsedB = readAnalysisCounters(pluginState(pluginB)).filesParsed;
    expect(parsedA).toBeGreaterThan(0);
    expect(parsedB).toBe(parsedA);
    const stateA = blankState();
    const stateB = blankState();
    session(dir, app, stateA);
    session(dir, app, stateB);
    expect(readAnalysisCounters(stateA).graphsBuilt).toBe(1);
    expect(readAnalysisCounters(stateB).graphsBuilt).toBe(1);
  });

  it('T18-A03b declaration source cache is per plugin instance', () => {
    const dir = tempDir('t18-a03b-decl-');
    const config = writeTsconfig(dir);
    const dts = path.join(dir, 'widget.d.ts');
    const textA = 'export class Widget { constructor(public markerA: MarkerA); }\nexport class MarkerA {}\n';
    const textB = 'export class Widget { constructor(public markerB: MarkerB); }\nexport class MarkerB {}\n';
    const user = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      "import { Widget } from './widget';",
      'export const c = defineBuilderConfig({ injections: [{ token: Widget }] });',
      'export const value = c.resolve(Widget);',
      '',
    ].join('\n');
    writeFileSync(path.join(dir, 'app.ts'), user);
    writeFileSync(dts, textA);
    const read = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, config);
    const stateA = blankState();
    const stateB = blankState();
    stateA.resolved = { root: dir, options: parsed.options, configPath: config };
    stateB.resolved = { root: dir, options: parsed.options, configPath: config };
    const sources = new Map<string, string>([[path.join(dir, 'app.ts'), user]]);
    usageErrorsAtBuildEnd(sources, stateA, 'strict');
    writeFileSync(dts, textB);
    usageErrorsAtBuildEnd(sources, stateB, 'strict');
    const stampA = [...stateA.declarationSources.values()].map((entry) => entry.stamp).join('\n');
    const stampB = [...stateB.declarationSources.values()].map((entry) => entry.stamp).join('\n');
    expect(stampA).toContain('markerA');
    expect(stampB).toContain('markerB');
    expect(stampA).not.toContain('markerB');
    expect(stampB).not.toContain('markerA');
  });

  it('T18-A04 leaf change reuses parsed files and graphsBuilt rises', () => {
    const dir = tempDir('t18-a04-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, {
      'contract.ts': 'export class Buddy {}\nexport class Shared { constructor() {} }\n',
      'leaf1.ts': leafSource('Only1'),
      'leaf2.ts': leafSource('Only2'),
      'leaf3.ts': leafSource('Only3'),
    });
    const state = blankState();
    const file = (name: string) => path.join(dir, name);
    const first1 = session(dir, file('leaf1.ts'), state);
    const first2 = session(dir, file('leaf2.ts'), state);
    const first3 = session(dir, file('leaf3.ts'), state);
    expect(readAnalysisCounters(state)).toMatchObject({ filesParsed: 4, graphsBuilt: 3 });
    writeFileSync(file('leaf1.ts'), leafSource('Only1', true));
    const edited = session(dir, file('leaf1.ts'), state);
    expect(readAnalysisCounters(state).graphsBuilt).toBe(4);
    expect(readAnalysisCounters(state).filesParsed).toBe(5);
    expect(edited).not.toBe(first1);
    expect(edited).toContain('Extra1');
    const again2 = session(dir, file('leaf2.ts'), state);
    const again3 = session(dir, file('leaf3.ts'), state);
    expect(again2).toBe(first2);
    expect(again3).toBe(first3);
    expect(readAnalysisCounters(state).filesParsed).toBe(5);
    expect(readAnalysisCounters(state).graphsBuilt).toBe(6);
    writeFileSync(file('contract.ts'), 'export class Buddy {}\nexport class Shared { constructor(public buddy: Buddy) {} }\n');
    const shared1 = session(dir, file('leaf1.ts'), state);
    const shared2 = session(dir, file('leaf2.ts'), state);
    const shared3 = session(dir, file('leaf3.ts'), state);
    expect(readAnalysisCounters(state).graphsBuilt).toBe(9);
    expect(readAnalysisCounters(state).filesParsed).toBe(6);
    expect(shared1).not.toBe(edited);
    expect(shared2).not.toBe(first2);
    expect(shared3).not.toBe(first3);
    expect(shared1).toContain('Buddy');
    expect(shared2).toContain('Buddy');
    expect(shared3).toContain('Buddy');
  });

  it('T18-A04b one host program builds graphs once for two marker files', () => {
    const dir = tempDir('t18-a04b-');
    writeTsconfig(dir);
    const left = path.join(dir, 'left.ts');
    const right = path.join(dir, 'right.ts');
    writeFileSync(left, containerSource('Left'));
    writeFileSync(right, containerSource('Right'));
    const config = path.join(dir, 'tsconfig.json');
    const read = ts.readConfigFile(config, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, config);
    const host = ts.createCompilerHost(parsed.options);
    const program = ts.createProgram([left, right], parsed.options, host);
    const state = blankState();
    const run = (file: string) => runCompilationSession({
      code: readFileSync(file, 'utf8'),
      id: file,
      cwd: dir,
      emitDebugHelpers: false,
      testOverrides: false,
      devtools: false,
      state,
      errorPrefix: '[neosyringe-transformer]',
      hostProgram: program,
      hostSource: program.getSourceFile(file),
    });
    const first = run(left);
    const built = readAnalysisCounters(state).graphsBuilt;
    const second = run(right);
    expect(first.code).toContain('new Left(');
    expect(second.code).toContain('new Right(');
    expect(readAnalysisCounters(state).graphsBuilt).toBe(built);
  });

  it('T18-A04b2 vite transforms the same file again and builds the graph again', () => {
    const dir = tempDir('t18-a04b2-');
    chdir(dir);
    const project = writeTsconfig(dir);
    const app = path.join(dir, 'app.ts');
    writeFileSync(app, containerSource('Alpha'));
    const plugin = hooks(project);
    const state = pluginState(plugin);
    const source = readFileSync(app, 'utf8');
    const first = plugin.transform(source, app);
    const built = readAnalysisCounters(state).graphsBuilt;
    const second = plugin.transform(source, app);
    expect(codeOf(second, source)).toBe(codeOf(first, source));
    expect(mapOf(second)).toEqual(mapOf(first));
    expect(readAnalysisCounters(state).graphsBuilt).toBe(built + 1);
  });

  it('T18-A04d buildEnd drops stored host graphs', () => {
    const dir = tempDir('t18-a04d-');
    chdir(dir);
    const project = writeTsconfig(dir);
    const app = path.join(dir, 'app.ts');
    writeFileSync(app, containerSource('Alpha'));
    const plugin = hooks(project);
    const code = transformFile(plugin, app);
    const state = pluginState(plugin);
    expect(state.graphs).toBeUndefined();
    const program = storeHostGraphs(dir, app, state);
    expect(state.graphs).toBeDefined();
    expect(state.graphProgram).toBe(program);
    plugin.buildEnd();
    expect(state.graphs).toBeUndefined();
    expect(state.graphProgram).toBeUndefined();
    expect(transformFile(plugin, app)).toBe(code);
  });

  it('T18-A04e watchChange delete drops stored host graphs', () => {
    const dir = tempDir('t18-a04e-');
    chdir(dir);
    const project = writeTsconfig(dir);
    const app = path.join(dir, 'app.ts');
    writeFileSync(app, containerSource('Alpha'));
    const plugin = hooks(project);
    transformFile(plugin, app);
    const state = pluginState(plugin);
    expect(state.graphs).toBeUndefined();
    storeHostGraphs(dir, app, state);
    expect(state.graphs).toBeDefined();
    plugin.watchChange(app, { event: 'delete' });
    expect(state.graphs).toBeUndefined();
    expect(state.graphProgram).toBeUndefined();
  });

  it('T18-A04c each edit builds another graph', () => {
    const dir = tempDir('t18-a04c-');
    chdir(dir);
    writeTsconfig(dir);
    const file = path.join(dir, 'app.ts');
    const state = blankState();
    for (const id of [1, 2, 3]) {
      writeFileSync(file, containerSource(`Alpha${id}`));
      session(dir, file, state);
    }
    expect(readAnalysisCounters(state).graphsBuilt).toBe(3);
    writeFileSync(file, containerSource('Alpha1'));
    session(dir, file, state);
    expect(readAnalysisCounters(state).graphsBuilt).toBe(4);
  });

  it('T18-A05 shared state and a blank state resolve the same values', () => {
    const dir = tempDir('t18-a05-');
    chdir(dir);
    writeTsconfig(dir);
    const file = path.join(dir, 'app.ts');
    writeFileSync(file, `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      export class Root { readonly id = 7; }
      export class Mid { constructor(public root: Root) {} }
      export class Leaf { constructor(public mid: Mid) {} }
      export const c = defineBuilderConfig({
        injections: [
          { token: Root },
          { token: Mid },
          { token: Leaf, lifecycle: 'transient' },
        ],
      });
    `);
    const blank = blankState();
    const shared = blankState();
    const blankOut = sessionFull(dir, file, blank);
    sessionFull(dir, file, shared);
    const sharedOut = sessionFull(dir, file, shared);
    expect(sharedOut.code).toBe(blankOut.code);
    expect(sharedOut.map).toEqual(blankOut.map);
    const fromBlank = executeContainer(blankOut.code);
    const fromShared = executeContainer(sharedOut.code);
    expect(fromBlank.left).not.toBe(fromBlank.right);
    expect(fromBlank.left.mid).toBe(fromBlank.right.mid);
    expect(fromBlank.left.mid.root).toBe(fromBlank.right.mid.root);
    expect(fromBlank.left.mid.root.id).toBe(7);
    expect(fromShared.left).not.toBe(fromShared.right);
    expect(fromShared.left.mid).toBe(fromShared.right.mid);
    expect(fromShared.left.mid.root.id).toBe(7);
    expect(fromShared.left.mid.root).toBe(fromShared.right.mid.root);
  });

  it('T18-A05b edit then undo matches a blank state', () => {
    const dir = tempDir('t18-a05b-');
    chdir(dir);
    writeTsconfig(dir);
    const file = path.join(dir, 'app.ts');
    const textA = providerSource(1);
    const textB = providerSource(2);
    writeFileSync(file, textA);
    const shared = blankState();
    sessionFull(dir, file, shared);
    writeFileSync(file, textB);
    sessionFull(dir, file, shared);
    writeFileSync(file, textA);
    const undone = sessionFull(dir, file, shared);
    const blank = sessionFull(dir, file, blankState());
    expect(readAnalysisCounters(shared).graphsBuilt).toBe(3);
    expect(undone.code).toBe(blank.code);
    expect(undone.map).toEqual(blank.map);
    expect(undone.map).not.toBeNull();
    const fromUndo = executeProvider(undone.code);
    const fromBlank = executeProvider(blank.code);
    expect(fromUndo).toBe(1);
    expect(fromBlank).toBe(1);
  });
});

function countTsconfigReads(run: () => void): number {
  const original = ts.sys.readFile;
  let reads = 0;
  ts.sys.readFile = (file, encoding) => {
    if (file.replace(/\\/g, '/').endsWith('/tsconfig.json')) reads += 1;
    return original.call(ts.sys, file, encoding);
  };
  try {
    run();
  } finally {
    ts.sys.readFile = original;
  }
  return reads;
}

function providerSource(id: number): string {
  return `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
export class Impl { readonly id = ${id}; }
export const c = defineBuilderConfig({
  injections: [{ token: Impl, useFactory: true, dependencies: [], provider: () => new Impl() }],
});
`;
}

function executeProvider(code: string): number {
  const runtime = require(path.join(ROOT, 'packages/neosyringe/dist/index.cjs')) as Record<string, unknown>;
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exportsObject: Record<string, unknown> = {};
  const run = new Function('exports', 'require', js) as (
    exportsObject: Record<string, unknown>,
    req: (id: string) => unknown,
  ) => void;
  run(exportsObject, (id: string) => {
    if (id === '@djodjonx/neosyringe') return runtime;
    throw new Error(`module inattendu: ${id}`);
  });
  const container = exportsObject.c as { resolve: (token: unknown) => { id: number } };
  return container.resolve(exportsObject.Impl).id;
}

function containerSource(name: string): string {
  return `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
export class ${name} { readonly id = 1; }
export const c = defineBuilderConfig({
  injections: [{ token: ${name} }],
});
`;
}

function leafSource(name: string, extra = false): string {
  const field = extra ? 'public shared: Shared, public extra: Extra1' : 'public shared: Shared';
  const extraClass = extra ? 'export class Extra1 {}\n' : '';
  const extraReg = extra ? '{ token: Extra1 },' : '';
  return `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Buddy, Shared } from './contract';
${extraClass}export class ${name} { constructor(${field}) {} }
export const c = defineBuilderConfig({
  injections: [
    { token: Buddy },
    { token: Shared },
    ${extraReg}
    { token: ${name} },
  ],
});
`;
}

function writeUnit(pkg: string, descriptor: string, runtimeKey: string): void {
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@acme/unit',
    version: '1.0.0',
    neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
  }));
  writeFileSync(path.join(pkg, 'dist/user.d.ts'), 'export interface User { id: number }\n');
  writeFileSync(path.join(pkg, 'dist/token.d.ts'), 'export declare const UserToken: unique symbol;\n');
  writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    packageName: '@acme/unit',
    contractVersion: 'contract-a',
    tokens: [{
      exportPath: 'dist/token.d.ts',
      exportName: 'UserToken',
      runtimeKey,
      descriptor,
      typeExport: { exportPath: 'dist/user.d.ts', exportName: 'User' },
    }],
  }));
}
