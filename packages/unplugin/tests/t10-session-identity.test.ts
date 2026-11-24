import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';
import { runCompilationSession, sessionStateKey, type SessionState } from '../src/session';

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

function keep(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function chdir(dir: string): void {
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
}

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function writeProject(dir: string): string {
  const file = path.join(dir, 'tsconfig.json');
  const neo = path.join(repoRoot(), 'packages/neosyringe/src/index.ts');
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
      paths: { '@djodjonx/neosyringe': [neo] },
    },
    include: ['*.ts'],
  }));
  return file;
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'object' && value !== null && 'registeredTokens' in value && 'usedTokens' in value;
}

function pluginState(plugin: object): SessionState {
  const value: unknown = Reflect.get(plugin, sessionStateKey);
  if (!isSessionState(value)) throw new Error('missing session');
  return value;
}

type SessionHooks = {
  buildEnd: () => void;
  watchChange: (id: string, change: { event: 'create' | 'update' | 'delete' }) => void;
  closeWatcher?: () => void;
};

function sessionHooks(plugin: ReturnType<typeof neoSyringePlugin.rollup>): SessionHooks {
  if (Array.isArray(plugin) || typeof plugin.buildEnd !== 'function' || typeof plugin.watchChange !== 'function') {
    throw new Error('hooks buildEnd et watchChange attendus');
  }
  return plugin as SessionHooks;
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

function compile(dir: string, project: string, state: SessionState, id: string, code: string): string {
  try {
    return runCompilationSession({
      code,
      id,
      project,
      cwd: dir,
      emitDebugHelpers: false,
      testOverrides: false,
      devtools: false,
      state,
      errorPrefix: '[neosyringe-plugin]',
    }).code;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const marked = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
export interface Marker { id: number }
class MarkerImpl implements Marker { id = 1 }
const token = useInterface<Marker>();
export const container = defineBuilderConfig({
  injections: [{ token: token, provider: MarkerImpl }],
});
export const used = token;
`;

const shifted = `// moved\n${marked}`;

function rootedSource(name: string): string {
  return `import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport const ${name} = defineBuilderConfig({ injections: [] });\n`;
}

describe('T10 session identity', () => {
  it('T10-S1-session-accepts-recompile-and-unrooted-ids', () => {
    const dir = keep('t10-s1-');
    const project = writeProject(dir);
    chdir(dir);
    const state = blankState();

    const first = compile(dir, project, state, '/abs/a.ts?v=1', marked);
    const again = compile(dir, project, state, '/abs/a.ts?v=2', marked);
    const edited = compile(dir, project, state, '/abs/a.ts?v=2', shifted);
    const windows = blankState();
    const windowsBack = compile(dir, project, windows, 'C:\\proj\\a.ts', marked);
    const windowsFwd = compile(dir, project, windows, 'C:/proj/a.ts', marked);

    const suffix = (text: string): string | undefined => text.match(/class NeoContainer_([0-9a-f]{24})/)?.[1];
    expect(suffix(first)).toMatch(/^[0-9a-f]{24}$/);
    expect(suffix(again)).toBe(suffix(first));
    expect(suffix(windowsFwd)).toBe(suffix(windowsBack));
    expect(suffix(windowsBack)).not.toBe(suffix(first));
    expect(edited).toContain('class NeoContainer_');

    const hashed = blankState();
    hashed.artifactHash = () => 'same-key';
    const file = path.join(dir, 'app.ts');
    const original = rootedSource('c');
    const moved = `// moved\n${original}`;
    compile(dir, project, hashed, file, original);
    const second = compile(dir, project, hashed, file, moved);
    expect(second).toContain('class NeoContainer_same-key');
  });

  it('T10-S2-session-refuses-two-artifacts', () => {
    const dir = keep('t10-s2-');
    const project = writeProject(dir);
    chdir(dir);
    const state = blankState();
    state.artifactHash = () => 'same-key';
    const left = compile(dir, project, state, path.join(dir, 'a.ts'), rootedSource('left'));
    expect(left).toContain('class NeoContainer_same-key');
    const refused = compile(dir, project, state, path.join(dir, 'b.ts'), rootedSource('right'));
    expect(refused).toBe('identity collision');
  });

  it('T10-S3 two unrooted files with one basename get different names', () => {
    const dir = keep('t10-s3-');
    const project = writeProject(dir);
    chdir(dir);
    const state = blankState();
    const code = rootedSource('box');
    const leftDir = keep('t10-s3-left-');
    const rightDir = keep('t10-s3-right-');
    const left = path.join(leftDir, 'Widget.ts');
    const right = path.join(rightDir, 'Widget.ts');
    writeFileSync(left, code);
    writeFileSync(right, code);
    const first = compile(dir, project, state, left, code);
    const second = compile(dir, project, state, right, code);
    const suffix = (text: string): string | undefined => text.match(/class NeoContainer_([0-9a-f]{24})/)?.[1];
    expect(first).toMatch(/class NeoContainer_[0-9a-f]{24}/);
    expect(second).toMatch(/class NeoContainer_[0-9a-f]{24}/);
    expect(suffix(second)).not.toBe(suffix(first));
  });

  it('T10-S4 nameless sibling packages are refused', () => {
    const parent = keep('t10-s4-');
    const code = rootedSource('app');
    const state = blankState();
    const compilePackage = (name: string): string => {
      const dir = path.join(parent, name);
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
      const project = writeProject(dir);
      const file = path.join(dir, 'src', 'app.ts');
      writeFileSync(file, code);
      return compile(dir, project, state, file, code);
    };
    expect(compilePackage('a')).toContain('class NeoContainer_');
    expect(compilePackage('b')).toBe('identity collision');
  });

  it('T10-S5 buildEnd keeps a live file and delete releases one', () => {
    const dir = keep('t10-s5-');
    const project = writeProject(dir);
    chdir(dir);
    const plugin = sessionHooks(neoSyringePlugin.rollup({ project }));
    const state = pluginState(plugin);
    const code = rootedSource('box');
    const fileA = path.join(keep('t10-s5-a-'), 'Widget.ts');
    const twinA = path.join(keep('t10-s5-a2-'), 'Widget.ts');
    const first = compile(dir, project, state, fileA, code);
    const twin = compile(dir, project, state, twinA, code);
    const suffix = (text: string): string | undefined => text.match(/class NeoContainer_([0-9a-f]{24})/)?.[1];
    expect(first).toMatch(/class NeoContainer_[0-9a-f]{24}/);
    expect(twin).toMatch(/class NeoContainer_[0-9a-f]{24}/);
    expect(suffix(twin)).not.toBe(suffix(first));

    state.artifactHash = () => 'same-key';
    const live = path.join(dir, 'live.ts');
    const other = path.join(dir, 'other.ts');
    const released = path.join(dir, 'released.ts');
    const still = path.join(dir, 'still.ts');
    const afterClose = path.join(dir, 'closed.ts');
    expect(compile(dir, project, state, live, code)).toContain('class NeoContainer_same-key');
    plugin.buildEnd();
    expect(compile(dir, project, state, other, code)).toBe('identity collision');
    plugin.watchChange(live, { event: 'delete' });
    expect(compile(dir, project, state, released, code)).toContain('class NeoContainer_same-key');
    expect(compile(dir, project, state, still, code)).toBe('identity collision');
    plugin.closeWatcher?.();
    expect(compile(dir, project, state, afterClose, code)).toContain('class NeoContainer_same-key');
  });

  it('T10-S6 two roots emit the same transformed code', () => {
    const writeTree = (prefix: string): { root: string; project: string; file: string; code: string } => {
      const root = keep(prefix);
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }));
      const project = writeProject(root);
      const code = rootedSource('app');
      const file = path.join(root, 'src', 'app.ts');
      writeFileSync(file, code);
      return { root, project, file, code };
    };
    const left = writeTree('t10-s6-left-');
    const right = writeTree('t10-s6-right-');
    const leftCode = compile(left.root, left.project, blankState(), left.file, left.code);
    const rightCode = compile(right.root, right.project, blankState(), right.file, right.code);
    expect(leftCode).toBe(rightCode);
    expect(leftCode).toContain('class NeoContainer_');
    expect(leftCode).not.toContain(left.root);
    expect(rightCode).not.toContain(right.root);
  });

  it('T10-S7 a host program without a config file does not use cwd', () => {
    const root = keep('t10-s7-');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    const web = path.join(root, 'web');
    mkdirSync(web);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }));
    const project = writeProject(root);
    const code = rootedSource('app');
    const file = path.join(root, 'src', 'app.ts');
    writeFileSync(file, code);
    const withProject = compile(root, project, blankState(), file, code);
    const read = ts.readConfigFile(project, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, project);
    const options = { ...parsed.options };
    delete options.configFilePath;
    const host = ts.createProgram([file], options);
    chdir(web);
    let hostCode = '';
    try {
      hostCode = runCompilationSession({
        code,
        id: file,
        cwd: web,
        emitDebugHelpers: false,
        testOverrides: false,
        devtools: false,
        state: blankState(),
        errorPrefix: '[neosyringe-plugin]',
        hostProgram: host,
        hostSource: host.getSourceFile(file),
      }).code;
    } catch (error) {
      hostCode = error instanceof Error ? error.message : String(error);
    }
    const suffix = (text: string): string | undefined => text.match(/class NeoContainer_([0-9a-f]{24})/)?.[1];
    expect(suffix(withProject)).toMatch(/^[0-9a-f]{24}$/);
    expect(suffix(hostCode)).toBe(suffix(withProject));
  });
});
