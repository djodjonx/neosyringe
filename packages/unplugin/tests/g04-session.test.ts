import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { Analyzer, ConfigCollector } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { readAnalysisCounters } from '../src/analysisCache';
import { neoSyringePlugin } from '../src/index';
import { sessionStateKey, type SessionState } from '../src/session';

/**
 * Topic 04: the incremental compilation session, seen through the public plugin hooks only
 * (transform, buildEnd, watchChange, buildStart, closeBundle, closeWatcher). Nothing here imports
 * a session module or reads a session field: a row is true or false by what a bundler can observe.
 */

const ROOT = repoRoot();
const dirs: string[] = [];
const opened: object[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  for (const plugin of opened.splice(0)) callHook(plugin, 'closeWatcher', { meta: { watchMode: false } }, []);
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
    paths: { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] },
    ...extra,
  };
}

function writeTsconfig(dir: string, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const file = path.join(dir, 'tsconfig.json');
  writeFileSync(file, JSON.stringify({ compilerOptions: compilerOptions(options), include: ['**/*.ts'], ...extra }));
  return file;
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'object' && value !== null && 'registeredTokens' in value && 'usedTokens' in value;
}

function stateOf(plugin: object): SessionState {
  const value: unknown = Reflect.get(plugin, sessionStateKey);
  if (!isSessionState(value)) throw new Error('missing session state');
  return value;
}

/** Calls a hook of a plugin object with the given `this`. A hook the plugin does not have is skipped. */
function callHook(plugin: object, name: string, context: object, args: unknown[]): unknown {
  const hook: unknown = Reflect.get(plugin, name);
  if (typeof hook !== 'function') return undefined;
  return Reflect.apply(hook, context, args);
}

interface Watch {
  event: 'create' | 'update' | 'delete';
}

class Hooks {
  readonly plugin: object;

  constructor(project: string) {
    this.plugin = neoSyringePlugin.vite({ project });
    opened.push(this.plugin);
  }

  transform(file: string, text?: string, context: object = {}): string {
    const source = text ?? readFileSync(file, 'utf8');
    const result = callHook(this.plugin, 'transform', context, [source, file]);
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && result !== null && 'code' in result && typeof result.code === 'string') return result.code;
    return source;
  }

  buildStart(watchMode = false): void {
    callHook(this.plugin, 'buildStart', { meta: { watchMode } }, [{}]);
  }

  buildEnd(context: object = {}): void {
    callHook(this.plugin, 'buildEnd', context, []);
  }

  watchChange(file: string, event: Watch['event']): void {
    callHook(this.plugin, 'watchChange', {}, [file, { event }]);
  }

  closeBundle(watchMode: boolean): void {
    callHook(this.plugin, 'closeBundle', { meta: { watchMode } }, []);
  }

  closeWatcher(): void {
    callHook(this.plugin, 'closeWatcher', { meta: { watchMode: true } }, []);
  }

  get state(): SessionState {
    return stateOf(this.plugin);
  }
}

/** The code a transform returns, or `error: <message>` when it throws. */
function outcome(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function captured(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

/** Number of `ts.sys.readFile` calls on a `.ts` file under `dir` while `run` executes. */
function projectReads(dir: string, run: () => void): number {
  const original = ts.sys.readFile;
  const base = dir.replace(/\\/g, '/');
  let reads = 0;
  ts.sys.readFile = (file, encoding) => {
    const name = file.replace(/\\/g, '/');
    if (name.startsWith(base) && name.endsWith('.ts')) reads += 1;
    return original.call(ts.sys, file, encoding);
  };
  try {
    run();
  } finally {
    ts.sys.readFile = original;
  }
  return reads;
}

/**
 * The file names, per analysis, of the containers the analyser collected while `run` executes. The collector is
 * observed, not replaced: it runs as always and its result is read. One entry per analysis.
 */
function collectedFiles(run: () => void): string[][] {
  const spy = vi.spyOn(ConfigCollector.prototype, 'collectAll');
  try {
    run();
    return spy.mock.results.map((result) => {
      if (result.type !== 'return') return [];
      return [...new Set([...result.value.configs.values()].map((config) => path.basename(config.sourceFile.fileName)))].sort();
    });
  } finally {
    spy.mockRestore();
  }
}

const NEO = "import { defineBuilderConfig } from '@djodjonx/neosyringe';";

/** Two dependencies and a token: each overlay adds an `Extra` constructor parameter. */
const APP_TWO = `
${NEO}
import { Dep } from './dep';
import { Other } from './other';
import { Extra } from './extra';
class App { constructor(public dep: Dep, public other: Other) {} }
export const c = defineBuilderConfig({
  injections: [{ token: Extra }, { token: Dep }, { token: Other }, { token: App }],
});
`;

function dependency(name: string, withExtra: boolean): string {
  return withExtra
    ? `import { Extra } from './extra';\nexport class ${name} { constructor(public extra: Extra) {} }\n`
    : `export class ${name} { constructor() {} }\n`;
}

/** One container that only registers `Dep`. */
const APP_DEP = `
${NEO}
import { Dep } from './dep';
export const c = defineBuilderConfig({ injections: [{ token: Dep }] });
`;

const CONTAINER_ALPHA = `${NEO}\nclass Alpha {}\nexport const c = defineBuilderConfig({ injections: [{ token: Alpha }] });\n`;
const DEP_PLAIN = 'export class Extra {}\nexport class Dep { constructor() {} }\n';
const DEP_NEEDS_EXTRA = 'export class Extra {}\nexport class Dep { constructor(public extra: Extra) {} }\n';

describe('G04 incremental compilation session', () => {
  it('G04-P1 A to B to A keeps the overlay of every transformed file', () => {
    const dir = tempDir('g04-p1-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, {
      'app.ts': APP_TWO,
      'dep.ts': dependency('Dep', false),
      'other.ts': dependency('Other', false),
      'extra.ts': 'export class Extra {}\n',
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const file = (name: string) => path.join(dir, name);
    // B for dep.ts and for other.ts: a text the bundler transformed, which is not the text on disk.
    hooks.transform(file('dep.ts'), dependency('Dep', true));
    hooks.transform(file('other.ts'), dependency('Other', true));
    const both = hooks.transform(file('app.ts'));
    expect(both).not.toContain('new Dep()');
    expect(both).not.toContain('new Other()');
    // dep.ts goes back to A: only that overlay goes. The one of other.ts is still there.
    hooks.transform(file('dep.ts'), dependency('Dep', false));
    const back = hooks.transform(file('app.ts'));
    expect(back).toContain('new Dep()');
    expect(back).not.toContain('new Other()');
    // and B again: the two overlays are visible together once more.
    hooks.transform(file('dep.ts'), dependency('Dep', true));
    const again = hooks.transform(file('app.ts'));
    expect(again).not.toContain('new Dep()');
    expect(again).not.toContain('new Other()');
  });

  it('G04-P2 a dependency type change changes the diagnostic of an untouched container', () => {
    const dir = tempDir('g04-p2-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    const dep = path.join(dir, 'dep.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    writeFileSync(dep, DEP_NEEDS_EXTRA);
    hooks.watchChange(dep, 'update');
    expect(captured(() => hooks.transform(app))).toContain('Extra');
    writeFileSync(dep, DEP_PLAIN);
    hooks.watchChange(dep, 'update');
    expect(hooks.transform(app)).toContain('new Dep()');
  });

  it('G04-P3 a file created after a missing import is seen, and a created file shadows a resolved import', () => {
    const dir = tempDir('g04-p3-');
    chdir(dir);
    // The files created below are not listed by the tsconfig: the roots stay the same, only what an import resolves to changes.
    writeTsconfig(dir, {}, { include: ['app.ts', 'app2.ts', 'shadow.d.ts'] });
    writeFiles(dir, {
      'app.ts': APP_DEP,
      // './shadow' resolves to the declaration file now. Once shadow.ts exists it wins, and app2.ts does not change.
      'shadow.d.ts': 'export declare class Extra {}\nexport declare class Dep { constructor(); }\n',
      'app2.ts': APP_DEP.replace("from './dep'", "from './shadow'"),
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    hooks.buildStart(true);
    const app = path.join(dir, 'app.ts');
    const dep = path.join(dir, 'dep.ts');
    expect(outcome(() => hooks.transform(app))).toMatch(/^error: /);
    writeFileSync(dep, DEP_PLAIN);
    hooks.watchChange(dep, 'create');
    expect(outcome(() => hooks.transform(app))).toContain('new Dep()');

    const app2 = path.join(dir, 'app2.ts');
    const shadow = path.join(dir, 'shadow.ts');
    expect(hooks.transform(app2)).toContain('new Dep()');
    writeFileSync(shadow, DEP_NEEDS_EXTRA);
    hooks.watchChange(shadow, 'create');
    expect(captured(() => hooks.transform(app2))).toContain('Extra');
  });

  it('G04-P4 a deleted file leaves no trace of its old text', () => {
    const dir = tempDir('g04-p4-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': 'export class Extra {}\nexport class Dep { readonly gone = "OLD-DEP-TEXT"; constructor() {} }\n' });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    const dep = path.join(dir, 'dep.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    unlinkSync(dep);
    hooks.watchChange(dep, 'delete');
    const after = captured(() => {
      const code = hooks.transform(app);
      throw new Error(`no failure: ${code}`);
    });
    expect(after).not.toContain('no failure');
    expect(after).not.toContain('OLD-DEP-TEXT');
  });

  it('G04-P5 a retargeted tsconfig path is followed, with and without a watcher event', () => {
    const dir = tempDir('g04-p5-');
    chdir(dir);
    writeFiles(dir, {
      'dep-a.ts': DEP_PLAIN,
      'dep-b.ts': DEP_NEEDS_EXTRA,
      'app.ts': APP_DEP.replace("from './dep'", "from '@app/dep'"),
    });
    const aliases = (target: string) => ({
      paths: { ...(compilerOptions().paths as Record<string, string[]>), '@app/dep': [target] },
    });
    const config = writeTsconfig(dir, aliases('./dep-a.ts'));
    const hooks = new Hooks(config);
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    writeTsconfig(dir, aliases('./dep-b.ts'));
    hooks.watchChange(config, 'update');
    expect(captured(() => hooks.transform(app))).toContain('Extra');
    // The legacy path: the file changes and no event comes.
    writeTsconfig(dir, aliases('./dep-a.ts'));
    expect(hooks.transform(app)).toContain('new Dep()');
  });

  it('G04-P6 a package.json exports change is followed', () => {
    const dir = tempDir('g04-p6-');
    chdir(dir);
    writeTsconfig(dir);
    const pkg = path.join(dir, 'node_modules/pkg');
    const manifest = (target: string) => JSON.stringify({ name: 'pkg', version: '1.0.0', exports: { '.': { types: target } } });
    writeFiles(dir, {
      'node_modules/pkg/package.json': manifest('./a.d.ts'),
      'node_modules/pkg/a.d.ts': 'export declare class Extra {}\nexport declare class Dep { constructor(); }\n',
      'node_modules/pkg/b.d.ts': 'export declare class Extra {}\nexport declare class Dep { constructor(extra: Extra); }\n',
      'app.ts': APP_DEP.replace("from './dep'", "from 'pkg'"),
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    writeFileSync(path.join(pkg, 'package.json'), manifest('./b.d.ts'));
    hooks.watchChange(path.join(pkg, 'package.json'), 'update');
    expect(captured(() => hooks.transform(app))).toContain('Extra');
  });

  it('G04-P7 a compilerOptions change rebuilds the program with the new options and parses every file again', () => {
    const dir = tempDir('g04-p7-');
    chdir(dir);
    const config = writeTsconfig(dir, { target: 'ES2022' });
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(config);
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    expect(hooks.state.previousProgram?.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2022);
    const parsed = readAnalysisCounters(hooks.state).filesParsed;
    writeTsconfig(dir, { target: 'ES2020' });
    hooks.watchChange(config, 'update');
    expect(hooks.transform(app)).toContain('new Dep()');
    const program = hooks.state.previousProgram;
    expect(program?.getCompilerOptions().target).toBe(ts.ScriptTarget.ES2020);
    const held = (program?.getSourceFiles() ?? []).filter((source) => !source.isDeclarationFile && source.fileName.startsWith(dir.replace(/\\/g, '/')));
    expect(held.length).toBeGreaterThan(1);
    expect(readAnalysisCounters(hooks.state).filesParsed - parsed).toBe(held.length);
  });

  it('G04-P8 buildEnd judges the overlay text of a dependency, from the program the transforms built', () => {
    const dir = tempDir('g04-p8-');
    chdir(dir);
    writeTsconfig(dir);
    const container = `${NEO}\nimport { Alpha } from './classes';\nexport const c = defineBuilderConfig({ injections: [{ token: Alpha }] });\n`;
    const usage = "import { c } from './c';\nimport { Wanted } from './tokens';\nexport const value = c.resolve(Wanted);\n";
    writeFiles(dir, {
      'classes.ts': 'export class Alpha {}\nexport class Beta {}\n',
      'tokens.ts': "export { Alpha as Wanted } from './classes';\n",
      'c.ts': container,
      'u.ts': usage,
    });
    const project = path.join(dir, 'tsconfig.json');
    const file = (name: string) => path.join(dir, name);
    // Guard: the text on disk passes the usage check.
    const disk = new Hooks(project);
    disk.transform(file('c.ts'));
    disk.transform(file('u.ts'));
    expect(captured(() => disk.buildEnd())).toBe('');
    // The bundler transformed tokens.ts into another text: the usage check must read that one.
    const hooks = new Hooks(project);
    hooks.transform(file('c.ts'));
    hooks.transform(file('u.ts'));
    hooks.transform(file('tokens.ts'), "export { Beta as Wanted } from './classes';\n");
    let message = '';
    const reads = projectReads(dir, () => {
      message = captured(() => hooks.buildEnd());
    });
    expect(message).toContain('unregistered token');
    expect(reads).toBe(0);
  });

  it('G04-P9 every tsconfig root is in the program, an ambient declaration included', () => {
    const dir = tempDir('g04-p9-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, {
      'decls.d.ts': "declare module 'ambient-x' { export class Ambient { constructor(); } }\n",
      'app.ts': `${NEO}\nimport { Ambient } from 'ambient-x';\nexport const c = defineBuilderConfig({ injections: [{ token: Ambient }] });\n`,
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    expect(outcome(() => hooks.transform(path.join(dir, 'app.ts')))).toContain('new Ambient()');
  });

  it('G04-P10 close frees the overlays at the real end of a build, not in watch mode', () => {
    const dir = tempDir('g04-p10-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const project = path.join(dir, 'tsconfig.json');
    const app = path.join(dir, 'app.ts');
    const dep = path.join(dir, 'dep.ts');

    const build = new Hooks(project);
    build.transform(dep, DEP_NEEDS_EXTRA);
    expect(captured(() => build.transform(app))).toContain('Extra');
    build.closeBundle(false);
    // A later build of the same plugin instance does not see the overlay of the first one.
    expect(build.transform(app)).toContain('new Dep()');

    const watch = new Hooks(project);
    watch.transform(dep, DEP_NEEDS_EXTRA);
    expect(captured(() => watch.transform(app))).toContain('Extra');
    watch.closeBundle(true);
    expect(captured(() => watch.transform(app))).toContain('Extra');
    watch.closeWatcher();
    expect(watch.transform(app)).toContain('new Dep()');
  });

  it('G04-P11 two plugin instances over two projects with the same file names stay apart', () => {
    const first = tempDir('g04-p11a-');
    const second = tempDir('g04-p11b-');
    for (const dir of [first, second]) {
      writeTsconfig(dir);
      writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    }
    chdir(first);
    const one = new Hooks(path.join(first, 'tsconfig.json'));
    const two = new Hooks(path.join(second, 'tsconfig.json'));
    const appOne = path.join(first, 'app.ts');
    const appTwo = path.join(second, 'app.ts');
    expect(one.transform(appOne)).toContain('new Dep()');
    expect(two.transform(appTwo)).toContain('new Dep()');
    writeFileSync(path.join(first, 'dep.ts'), DEP_NEEDS_EXTRA);
    one.watchChange(path.join(first, 'dep.ts'), 'update');
    expect(captured(() => one.transform(appOne))).toContain('Extra');
    expect(two.transform(appTwo)).toContain('new Dep()');
    writeFileSync(path.join(second, 'dep.ts'), DEP_NEEDS_EXTRA);
    two.watchChange(path.join(second, 'dep.ts'), 'update');
    writeFileSync(path.join(first, 'dep.ts'), DEP_PLAIN);
    one.watchChange(path.join(first, 'dep.ts'), 'update');
    expect(one.transform(appOne)).toContain('new Dep()');
    expect(captured(() => two.transform(appTwo))).toContain('Extra');
  });

  it('G04-P12 an edit parses one file again, a target change parses them all again', () => {
    const dir = tempDir('g04-p12-');
    chdir(dir);
    const config = writeTsconfig(dir, { target: 'ES2022' });
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(config);
    const app = path.join(dir, 'app.ts');
    const parsed = (): number => readAnalysisCounters(hooks.state).filesParsed;
    hooks.transform(app);
    const cold = parsed();
    expect(cold).toBeGreaterThan(1);
    hooks.transform(app);
    expect(parsed()).toBe(cold);
    writeFileSync(path.join(dir, 'dep.ts'), DEP_NEEDS_EXTRA);
    hooks.watchChange(path.join(dir, 'dep.ts'), 'update');
    captured(() => hooks.transform(app));
    expect(parsed() - cold).toBe(1);
    const before = parsed();
    writeTsconfig(dir, { target: 'ES2020' });
    hooks.watchChange(config, 'update');
    captured(() => hooks.transform(app));
    const held = (hooks.state.previousProgram?.getSourceFiles() ?? []).filter((source) => !source.isDeclarationFile && source.fileName.startsWith(dir.replace(/\\/g, '/')));
    expect(parsed() - before).toBe(held.length);
  });

  it('G04-P13 a change of positions only moves the reported positions', () => {
    const dir = tempDir('g04-p13-');
    chdir(dir);
    writeTsconfig(dir);
    const container = `${NEO}\nclass Alpha {}\nexport const c = defineBuilderConfig({ injections: [{ token: Alpha }] });\n`;
    const body = "import { c } from './c';\nclass Missing {}\nexport const value = c.resolve(Missing);\n";
    writeFiles(dir, { 'c.ts': container, 'u.ts': body });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    // A watch build: its buildEnd does not close the session, so the next build reuses what it parsed.
    hooks.buildStart(true);
    const c = path.join(dir, 'c.ts');
    const u = path.join(dir, 'u.ts');
    hooks.transform(c);
    hooks.transform(u);
    expect(captured(() => hooks.buildEnd())).toMatch(/u\.ts:3:/);
    const moved = `// one\n// two\n${body}`;
    writeFileSync(u, moved);
    hooks.watchChange(u, 'update');
    hooks.transform(c);
    hooks.transform(u, moved);
    expect(captured(() => hooks.buildEnd())).toMatch(/u\.ts:5:/);
  });

  it('G04-P14 a broken container in another root does not fail this transform', () => {
    const dir = tempDir('g04-p14-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, {
      'app.ts': `${NEO}\nclass Alpha {}\nexport const c = defineBuilderConfig({ injections: [{ token: Alpha }] });\n`,
      'broken.ts': `${NEO}\nclass Needed {}\nclass Bad { constructor(public needed: Needed) {} }\nexport const b = defineBuilderConfig({ injections: [{ token: Bad }] });\n`,
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    expect(captured(() => hooks.transform(path.join(dir, 'broken.ts')))).toContain('Needed');
    expect(hooks.transform(path.join(dir, 'app.ts'))).toContain('new Alpha()');
  });

  it('G04-P15 tsconfig references are announced as not followed, once, and the root project still works', () => {
    const dir = tempDir('g04-p15-');
    chdir(dir);
    writeFiles(dir, {
      'sub/tsconfig.json': JSON.stringify({ compilerOptions: compilerOptions({ composite: true }), include: ['*.ts'] }),
      'sub/dep.ts': DEP_PLAIN,
      'app.ts': APP_DEP.replace("from './dep'", "from './sub/dep'"),
    });
    const config = writeTsconfig(dir, {}, { include: ['*.ts'], references: [{ path: './sub' }] });
    const hooks = new Hooks(config);
    const app = path.join(dir, 'app.ts');
    const notices: string[] = [];
    const context = { warn: (message: string) => { notices.push(message); } };
    expect(hooks.transform(app, undefined, context)).toContain('new Dep()');
    expect(hooks.transform(app, undefined, context)).toContain('new Dep()');
    const about = notices.filter((message) => message.includes('references'));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain('[NeoSyringe]');
  });
  it('G04-P16 a leaf edit in one container does not analyse an unrelated container', () => {
    const dir = tempDir('g04-p16-');
    chdir(dir);
    writeTsconfig(dir);
    const unrelated = (name: string) => `${NEO}\nclass ${name} {}\nexport const c = defineBuilderConfig({ injections: [{ token: ${name} }] });\n`;
    writeFiles(dir, {
      'x.ts': APP_DEP,
      'dep.ts': DEP_PLAIN,
      'y1.ts': unrelated('Y1'),
      'y2.ts': unrelated('Y2'),
      'y3.ts': unrelated('Y3'),
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    hooks.buildStart(true);
    const file = (name: string) => path.join(dir, name);
    for (const name of ['x.ts', 'y1.ts', 'y2.ts', 'y3.ts']) hooks.transform(file(name));
    writeFileSync(file('dep.ts'), DEP_NEEDS_EXTRA);
    hooks.watchChange(file('dep.ts'), 'update');
    // X now fails on Extra: the analysis that found it collected the containers of X and of what X imports, nothing else.
    let message = '';
    const analyses = collectedFiles(() => {
      message = captured(() => hooks.transform(file('x.ts')));
    });
    expect(message).toContain('Extra');
    expect(analyses).toEqual([['x.ts']]);
    // Y1 is still right, and analysing it collects Y1 alone.
    let code = '';
    const next = collectedFiles(() => {
      code = hooks.transform(file('y1.ts'));
    });
    expect(code).toContain('new Y1()');
    expect(next).toEqual([['y1.ts']]);
  });

  it('G04-P17 a parent container in another file still resolves after its own file changes', () => {
    const dir = tempDir('g04-p17-');
    chdir(dir);
    writeTsconfig(dir);
    const parent = (injections: string) => `${NEO}\nexport class Logger { constructor() {} }\nexport const parent = defineBuilderConfig({ injections: [${injections}] });\n`;
    writeFiles(dir, {
      'parent.ts': parent('{ token: Logger }'),
      'child.ts': `${NEO}\nimport { parent, Logger } from './parent';\nclass Consumer { constructor(public logger: Logger) {} }\nexport const child = defineBuilderConfig({ useContainer: parent, injections: [{ token: Consumer }] });\n`,
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    hooks.buildStart(true);
    const child = path.join(dir, 'child.ts');
    const reference = hooks.transform(child);
    expect(reference).not.toContain('new Consumer(undefined)');
    expect(reference).toContain('new Consumer(');
    // The parent stops providing Logger: the child, which did not change, now misses it.
    writeFileSync(path.join(dir, 'parent.ts'), parent(''));
    hooks.watchChange(path.join(dir, 'parent.ts'), 'update');
    expect(captured(() => hooks.transform(child))).toContain('Logger');
    // The parent provides it again: the child is the same as it was.
    writeFileSync(path.join(dir, 'parent.ts'), parent('{ token: Logger }'));
    hooks.watchChange(path.join(dir, 'parent.ts'), 'update');
    expect(hooks.transform(child)).toBe(reference);
  });
  it('G04-P18 a parent container shipped as TypeScript source by a package is analysed with its child', () => {
    const dir = tempDir('g04-p18-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, {
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', types: './index.ts' }),
      'node_modules/pkg/index.ts': `${NEO}\nexport class Logger { constructor() {} }\nexport const parent = defineBuilderConfig({ injections: [{ token: Logger }] });\n`,
      'child.ts': `${NEO}\nimport { parent, Logger } from 'pkg';\nclass Consumer { constructor(public logger: Logger) {} }\nexport const child = defineBuilderConfig({ useContainer: parent, injections: [{ token: Consumer }] });\n`,
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const code = outcome(() => hooks.transform(path.join(dir, 'child.ts')));
    expect(code).not.toMatch(/^error: /);
    expect(code).not.toContain('new Consumer(undefined)');
    expect(code).toContain('new Consumer(');
  });

  it('G04-P19 two environments of one plugin keep their own overlays, and alternating them parses nothing again', () => {
    const dir = tempDir('g04-p19-');
    chdir(dir);
    writeTsconfig(dir);
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    const client = { environment: { name: 'client' } };
    const server = { environment: { name: 'ssr' } };
    // dep.ts is transformed into another text for the client only.
    hooks.transform(path.join(dir, 'dep.ts'), DEP_NEEDS_EXTRA, client);
    expect(captured(() => hooks.transform(app, undefined, client))).toContain('Extra');
    // The server never saw that text: it reads the disk.
    expect(outcome(() => hooks.transform(app, undefined, server))).toContain('new Dep()');
    const parsed = readAnalysisCounters(hooks.state).filesParsed;
    for (let round = 0; round < 3; round += 1) {
      expect(captured(() => hooks.transform(app, undefined, client))).toContain('Extra');
      expect(outcome(() => hooks.transform(app, undefined, server))).toContain('new Dep()');
    }
    expect(readAnalysisCounters(hooks.state).filesParsed).toBe(parsed);
  });

  it('G04-P20 an edit of an imported declaration file, with no watcher event, is seen by the next transform', () => {
    const dir = tempDir('g04-p20-');
    chdir(dir);
    // types.d.ts is imported, not a root: only the import closure reaches it.
    writeTsconfig(dir, {}, { include: ['app.ts'] });
    const declared = (parameters: string) => `export declare class Extra {}\nexport declare class Dep { constructor(${parameters}); }\n`;
    writeFiles(dir, { 'app.ts': APP_DEP.replace("from './dep'", "from './types'"), 'types.d.ts': declared('') });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    writeFileSync(path.join(dir, 'types.d.ts'), declared('extra: Extra'));
    expect(captured(() => hooks.transform(app))).toContain('Extra');
    writeFileSync(path.join(dir, 'types.d.ts'), declared(''));
    expect(hooks.transform(app)).toContain('new Dep()');
  });

  it('G04-P21 an edit of an ambient declaration root, with no watcher event, is seen by the next transform', () => {
    const dir = tempDir('g04-p21-');
    chdir(dir);
    writeTsconfig(dir);
    const ambient = (parameters: string) => `declare module 'ambient-x' { export class Extra {} export class Ambient { constructor(${parameters}); } }\n`;
    writeFiles(dir, {
      'decls.d.ts': ambient(''),
      'app.ts': `${NEO}\nimport { Ambient } from 'ambient-x';\nexport const c = defineBuilderConfig({ injections: [{ token: Ambient }] });\n`,
    });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Ambient()');
    writeFileSync(path.join(dir, 'decls.d.ts'), ambient('extra: Extra'));
    expect(captured(() => hooks.transform(app))).toContain('Extra');
  });

  it('G04-P22 a creation event does not load the tsconfig roots into a session that holds only unlisted files', () => {
    const dir = tempDir('g04-p22-');
    chdir(dir);
    // app.ts and dep.ts are not listed by the tsconfig: the session holds them alone, as the plugin always did.
    writeTsconfig(dir, {}, { include: ['listed.ts'] });
    writeFiles(dir, { 'listed.ts': 'export const listed = 1;\n', 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    hooks.buildStart(true);
    const app = path.join(dir, 'app.ts');
    const held = (): string[] => (hooks.state.previousProgram?.getSourceFiles() ?? [])
      .filter((source) => !source.isDeclarationFile && source.fileName.startsWith(dir.replace(/\\/g, '/')))
      .map((source) => path.basename(source.fileName))
      .sort();
    expect(hooks.transform(app)).toContain('new Dep()');
    expect(held()).toEqual(['app.ts', 'dep.ts']);
    writeFileSync(path.join(dir, 'later.ts'), 'export const later = 1;\n');
    hooks.watchChange(path.join(dir, 'later.ts'), 'create');
    expect(hooks.transform(app)).toContain('new Dep()');
    expect(held()).toEqual(['app.ts', 'dep.ts']);
  });

  it('G04-P23 the lib files survive the end of a build: the next build gets the same SourceFile', () => {
    const dir = tempDir('g04-p23-');
    chdir(dir);
    writeTsconfig(dir, { noLib: false, lib: ['es5'] });
    writeFiles(dir, { 'app.ts': APP_DEP, 'dep.ts': DEP_PLAIN });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const app = path.join(dir, 'app.ts');
    expect(hooks.transform(app)).toContain('new Dep()');
    const first = hooks.state.previousProgram;
    const lib = first?.getSourceFiles().find((source) => first.isSourceFileDefaultLibrary(source));
    expect(lib).toBeDefined();
    // A build that is not a watch build ends: the session closes. An esbuild rebuild starts a new one.
    hooks.buildEnd();
    expect(hooks.transform(app)).toContain('new Dep()');
    // Booleans: a failing `toBe` on a SourceFile prints the whole tree.
    expect(hooks.state.previousProgram === first).toBe(false);
    expect(hooks.state.previousProgram?.getSourceFile(lib?.fileName ?? '') === lib).toBe(true);
  });

  it('G04-P24 a file that stops calling resolve is not checked again at the end of a watch build', () => {
    const dir = tempDir('g04-p24-');
    chdir(dir);
    writeTsconfig(dir);
    const withCall = "import { c } from './c';\nclass Missing {}\nexport const value = c.resolve(Missing);\n";
    writeFiles(dir, { 'c.ts': CONTAINER_ALPHA, 'u.ts': withCall });
    const hooks = new Hooks(path.join(dir, 'tsconfig.json'));
    const c = path.join(dir, 'c.ts');
    const u = path.join(dir, 'u.ts');
    hooks.buildStart(true);
    hooks.transform(c);
    hooks.transform(u);
    expect(captured(() => hooks.buildEnd())).toMatch(/u\.ts:3:/);
    // A named import already makes a file a candidate (markerUtils), so the new text has none.
    const without = 'export const value = 1;\n';
    writeFileSync(u, without);
    hooks.watchChange(u, 'update');
    hooks.buildStart(true);
    hooks.transform(c);
    hooks.transform(u, without);
    const spy = vi.spyOn(Analyzer.prototype, 'extractForFile');
    try {
      expect(captured(() => hooks.buildEnd())).toBe('');
      const checked = spy.mock.calls.map(([file]) => path.basename(file));
      expect(checked).toContain('c.ts');
      expect(checked).not.toContain('u.ts');
    } finally {
      spy.mockRestore();
    }
  });
});
