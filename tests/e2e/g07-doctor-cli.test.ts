import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// G07 stage G: `neosyringe-check doctor` through the built binary, on scratch projects whose node_modules hold
// the real built packages (a package.json copy as `pnpm pack` writes it, `dist` linked to the build). Needs `pnpm build`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repoRoot, 'packages/cli/dist/index.mjs');

// [folder under packages/, folder under node_modules/@djodjonx/]
const PACKAGES = [
  ['core', 'neosyringe-core'],
  ['cli', 'neosyringe-cli'],
  ['lsp', 'neosyringe-lsp'],
  ['neosyringe', 'neosyringe'],
  ['ui', 'neosyringe-ui'],
  ['unplugin', 'neosyringe-plugin'],
] as const;

const CHECK_IDS = ['typescript', 'neosyringe-packages', 'package-exports', 'tsconfig', 'integration'];

const SECRET_CONFIG = 'sk-live-TOPSECRET-123';
const SECRET_ENV = 'env-secret-456';
const FACTORY_MARKER = 'FACTORY_BODY_MARKER';
const APP_EFFECT = 'APP_SIDE_EFFECT_RAN';
const TSCONFIG_MARKER = 'TSCONFIG_SECRET_MARKER';

const DECLARED_CONFIG = `import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin';
export default { plugins: [neoSyringePlugin.vite()] };
`;

interface Check {
  id: string;
  status: 'ok' | 'warning' | 'error' | 'unknown';
  message: string;
  remedy?: string;
}

interface DoctorJson {
  schemaVersion: number;
  ok: boolean;
  exitCode: number;
  checks: Check[];
}

interface ProjectOptions {
  /** The typescript of node_modules: the real one (default), a stub with this version, or none. */
  typescript?: { version: string } | 'absent';
  /** Version written in the installed core package.json. The cli, lsp, ui and plugin copies still ask for the repository's. */
  coreVersion?: string;
  /**
   * pnpm's isolated layout: only the plugin is a dependency of the project. It is a symlink to a real folder in the
   * store, and the packages it needs (core, ui) sit next to that real folder, not in the project.
   * `core` is the state of the core copy there.
   */
  isolated?: { core: 'matching' | 'outside-range' | 'missing' };
  /** Package whose `dist` is left out of node_modules. */
  withoutDist?: string;
  /** The bundler config file, if any. */
  config?: { file: string; text: string };
  /** Extra project files. */
  files?: Record<string, string>;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let scratch = '';
let counter = 0;

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function repoVersion(folder: string): string {
  const version = readJson(path.join(repoRoot, 'packages', folder, 'package.json')).version;
  if (typeof version !== 'string') throw new Error(`no version for ${folder}`);
  return version;
}

/** `workspace:*` as `pnpm pack` writes it: the version of the sibling in the repository. */
function rewriteWorkspace(dependencies: unknown): unknown {
  if (typeof dependencies !== 'object' || dependencies === null) return dependencies;
  const rewritten: Record<string, unknown> = {};
  for (const [name, range] of Object.entries(dependencies)) {
    if (range !== 'workspace:*') {
      rewritten[name] = range;
      continue;
    }
    const owner = PACKAGES.find(([, installed]) => `@djodjonx/${installed}` === name);
    if (!owner) throw new Error(`unknown workspace dependency ${name}`);
    rewritten[name] = repoVersion(owner[0]);
  }
  return rewritten;
}

function makeProject(options: ProjectOptions = {}): string {
  counter += 1;
  const dir = path.join(scratch, `project-${counter}`);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    '//': TSCONFIG_MARKER,
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES5'], types: [], skipLibCheck: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(path.join(dir, 'src/app.ts'), `export const secret = '${FACTORY_MARKER}';\nconsole.log('${APP_EFFECT}');\n`);
  const modules = path.join(dir, 'node_modules');
  mkdirSync(path.join(modules, '@djodjonx'), { recursive: true });
  const coreVersion = options.coreVersion ?? repoVersion('core');
  const isolatedStore = path.join(modules, '.pnpm/plugin/node_modules/@djodjonx');
  for (const [folder, installed] of PACKAGES) {
    const insideStore = options.isolated !== undefined && (folder === 'unplugin' || folder === 'core' || folder === 'ui');
    if (options.isolated !== undefined && !insideStore) continue;
    if (options.isolated?.core === 'missing' && folder === 'core') continue;
    const target = path.join(insideStore ? isolatedStore : path.join(modules, '@djodjonx'), installed);
    mkdirSync(target, { recursive: true });
    const source = readJson(path.join(repoRoot, 'packages', folder, 'package.json'));
    const copy = {
      ...source,
      version: folder === 'core' ? (options.isolated?.core === 'outside-range' ? '0.0.1' : coreVersion) : source.version,
      dependencies: rewriteWorkspace(source.dependencies),
    };
    writeFileSync(path.join(target, 'package.json'), JSON.stringify(copy, null, 2));
    if (options.withoutDist !== `@djodjonx/${installed}`) {
      symlinkSync(path.join(repoRoot, 'packages', folder, 'dist'), path.join(target, 'dist'));
    }
  }
  if (options.isolated !== undefined) {
    symlinkSync(path.join(isolatedStore, 'neosyringe-plugin'), path.join(modules, '@djodjonx/neosyringe-plugin'), 'dir');
  }
  if (options.typescript === undefined) {
    symlinkSync(path.join(repoRoot, 'node_modules/typescript'), path.join(modules, 'typescript'));
  } else if (options.typescript !== 'absent') {
    mkdirSync(path.join(modules, 'typescript'), { recursive: true });
    writeFileSync(path.join(modules, 'typescript/package.json'), JSON.stringify({ name: 'typescript', version: options.typescript.version }));
  }
  if (options.config) writeFileSync(path.join(dir, options.config.file), options.config.text);
  for (const [name, text] of Object.entries(options.files ?? {})) writeFileSync(path.join(dir, name), text);
  return dir;
}

function doctor(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): Run {
  const result = spawnSync(process.execPath, [cli, 'doctor', ...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function report(cwd: string): { run: Run; json: DoctorJson } {
  const run = doctor(cwd, ['--json']);
  const json = JSON.parse(run.stdout) as DoctorJson;
  expect(Array.isArray(json.checks), `no checks in ${run.stdout}`).toBe(true);
  return { run, json };
}

function checkOf(json: DoctorJson, id: string): Check {
  const found = json.checks.find((check) => check.id === id);
  if (!found) throw new Error(`no ${id} in ${JSON.stringify(json.checks.map((check) => check.id))}`);
  return found;
}

/** Hash of every path, file content and link target under `dir`. Links are not followed. */
function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const visit = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const stat = lstatSync(full);
      hash.update(`${path.relative(dir, full)}\0`);
      if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(full)}`);
      else if (stat.isDirectory()) visit(full);
      else hash.update(readFileSync(full));
    }
  };
  visit(dir);
  return hash.digest('hex');
}

describe('G07 doctor command', () => {
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'g07-doctor-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('G07-P5 a compatible project: every check is ok and the exit code is 0, in text and in JSON', () => {
    const dir = makeProject({ config: { file: 'vite.config.ts', text: DECLARED_CONFIG } });
    const text = doctor(dir);
    const { run, json } = report(dir);
    const typescriptVersion = readJson(path.join(repoRoot, 'node_modules/typescript/package.json')).version;

    expect(text.status).toBe(0);
    for (const id of CHECK_IDS) expect(text.stdout).toMatch(new RegExp(`^ok\\s+${id}\\b`, 'm'));
    expect(text.stdout).toContain(`typescript ${String(typescriptVersion)}`);
    expect(text.stdout).toMatch(/^ok\s+integration\b.*declared in vite\.config\.ts/m);
    expect(text.stdout).not.toMatch(/^ok\s+integration\b.*\bactive\b/m);
    expect(run.status).toBe(0);
    expect(json).toMatchObject({ schemaVersion: 1, ok: true, exitCode: 0 });
    expect(json.checks.map((check) => check.id)).toEqual(CHECK_IDS);
    expect(json.checks.map((check) => check.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(checkOf(json, 'integration').message).toContain('declared in vite.config.ts');
    expect(checkOf(json, 'integration').message).toMatch(/not proven/i);
  });

  it('G07-P6 a typescript below the supported range is an error and the exit code is 1', () => {
    const dir = makeProject({ typescript: { version: '4.9.5' }, config: { file: 'vite.config.ts', text: DECLARED_CONFIG } });
    const text = doctor(dir);
    const { run, json } = report(dir);

    expect(text.status).toBe(1);
    expect(text.stdout).toMatch(/^ERROR\s+typescript\b.*4\.9\.5/m);
    expect(text.stdout).toMatch(/^\s+Fix: /m);
    expect(run.status).toBe(1);
    expect(json).toMatchObject({ ok: false, exitCode: 1 });
    expect(checkOf(json, 'typescript')).toMatchObject({ status: 'error' });
    expect(checkOf(json, 'typescript').remedy).toBeDefined();
    expect(json.checks.filter((check) => check.status === 'error').map((check) => check.id)).toEqual(['typescript']);
  });

  it('G07-P6 a missing typescript is an error', () => {
    const { run, json } = report(makeProject({ typescript: 'absent', config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));

    expect(run.status).toBe(1);
    expect(checkOf(json, 'typescript').status).toBe('error');
  });

  it('G07-P6 a core version outside the range a package depends on is an error', () => {
    const { run, json } = report(makeProject({ coreVersion: '0.0.1', config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));

    expect(run.status).toBe(1);
    expect(checkOf(json, 'neosyringe-packages').status).toBe('error');
    expect(checkOf(json, 'neosyringe-packages').message).toContain('0.0.1');
    expect(json.checks.filter((check) => check.status === 'error').map((check) => check.id)).toEqual(['neosyringe-packages']);
  });

  it('G07-I2 pnpm-like layout, core next to the real plugin and matching: ok, read from the store', () => {
    const { run, json } = report(makeProject({ isolated: { core: 'matching' }, config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));
    const packages = checkOf(json, 'neosyringe-packages');

    expect(run.status).toBe(0);
    expect(packages.status).toBe('ok');
    expect(packages.message).toContain('@djodjonx/neosyringe-plugin needs @djodjonx/neosyringe-core');
    expect(packages.message).toContain('.pnpm/plugin/node_modules/@djodjonx/neosyringe-core');
  });

  it('G07-I2 pnpm-like layout, core next to the real plugin but outside its range: an error, exit 1', () => {
    const { run, json } = report(makeProject({ isolated: { core: 'outside-range' }, config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));
    const packages = checkOf(json, 'neosyringe-packages');

    expect(run.status).toBe(1);
    expect(packages.status).toBe('error');
    expect(packages.message).toContain('@djodjonx/neosyringe-core');
    expect(packages.message).toContain('found 0.0.1');
  });

  it('G07-I2 pnpm-like layout, core the plugin cannot find: unknown, never ok, exit 0', () => {
    const { run, json } = report(makeProject({ isolated: { core: 'missing' }, config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));
    const packages = checkOf(json, 'neosyringe-packages');

    expect(run.status).toBe(0);
    expect(packages.status).toBe('unknown');
    expect(packages.message).toContain('cannot be found from');
  });

  it('G07-P6 a package whose export target is not on disk is an error that names the package and the target', () => {
    const { run, json } = report(makeProject({ withoutDist: '@djodjonx/neosyringe-lsp', config: { file: 'vite.config.ts', text: DECLARED_CONFIG } }));

    expect(run.status).toBe(1);
    expect(checkOf(json, 'package-exports').status).toBe('error');
    expect(checkOf(json, 'package-exports').message).toContain('@djodjonx/neosyringe-lsp');
    expect(checkOf(json, 'package-exports').message).toContain('dist/index.cjs');
    expect(json.checks.filter((check) => check.status === 'error').map((check) => check.id)).toEqual(['package-exports']);
  });

  it('G07-P6 a project with no tsconfig is an error of the tsconfig check', () => {
    const dir = makeProject({ config: { file: 'vite.config.ts', text: DECLARED_CONFIG } });
    rmSync(path.join(dir, 'tsconfig.json'));
    const { run, json } = report(dir);

    expect(run.status).toBe(1);
    expect(checkOf(json, 'tsconfig').status).toBe('error');
  });

  it('G07-P7 a dynamic config is unknown, never ok, and does not fail the run', () => {
    const dir = makeProject({
      config: {
        file: 'vite.config.ts',
        text: "const load = (name: string) => require(name);\nexport default { plugins: [...makePlugins(load)] };\n",
      },
    });
    const text = doctor(dir);
    const { run, json } = report(dir);

    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/^unknown\s+integration\b/m);
    expect(text.stdout).not.toMatch(/^ok\s+integration\b/m);
    expect(run.status).toBe(0);
    expect(checkOf(json, 'integration').status).toBe('unknown');
    expect(json).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('G07-P7 a static config that never mentions the plugin is a warning; no known config file is unknown', () => {
    const warned = report(makeProject({ config: { file: 'vite.config.ts', text: 'export default { plugins: [] };\n' } }));
    const absent = report(makeProject());

    expect(warned.run.status).toBe(0);
    expect(checkOf(warned.json, 'integration').status).toBe('warning');
    expect(checkOf(warned.json, 'integration').remedy).toBeDefined();
    expect(absent.run.status).toBe(0);
    expect(checkOf(absent.json, 'integration').status).toBe('unknown');
    expect(doctor(makeProject({ config: { file: 'vite.config.ts', text: 'export default { plugins: [] };\n' } })).stdout)
      .toMatch(/^warning\s+integration\b/m);
  });

  it('G07-P8 doctor changes nothing, runs no application code and prints no config value, secret or factory source', () => {
    const dir = makeProject({
      config: {
        file: 'vite.config.ts',
        text: `${DECLARED_CONFIG}const API_KEY = '${SECRET_CONFIG}';\nexport const define = { KEY: API_KEY };\n`,
      },
    });
    const env = { ...process.env, NEO_DOCTOR_SECRET: SECRET_ENV };
    const before = treeHash(dir);
    const text = doctor(dir, [], env);
    const json = doctor(dir, ['--json'], env);
    const after = treeHash(dir);
    const everything = `${text.stdout}\n${text.stderr}\n${json.stdout}\n${json.stderr}`;

    expect(text.status).toBe(0);
    expect(json.status).toBe(0);
    expect(text.stdout).toMatch(/^ok\s+tsconfig\b/m);
    expect((JSON.parse(json.stdout) as DoctorJson).checks.length).toBe(CHECK_IDS.length);
    expect(after).toBe(before);
    for (const forbidden of [SECRET_CONFIG, SECRET_ENV, FACTORY_MARKER, APP_EFFECT, TSCONFIG_MARKER]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it('G07-P8 an unknown flag or a missing project path is a usage error (exit 2)', () => {
    const dir = makeProject({ config: { file: 'vite.config.ts', text: DECLARED_CONFIG } });
    const unknownFlag = doctor(dir, ['--graph']);
    const missingPath = doctor(dir, ['--project']);
    const asJson = doctor(dir, ['--json', '--bogus']);

    expect(unknownFlag.status).toBe(2);
    expect(unknownFlag.stderr).toContain('doctor');
    expect(unknownFlag.stderr).toContain('--graph');
    expect(missingPath.status).toBe(2);
    expect(asJson.status).toBe(2);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ schemaVersion: 1, ok: false, fatal: expect.stringContaining('--bogus') });
  });

  it('G07-P5 --project names the tsconfig doctor reads, relative to the working directory', () => {
    const dir = makeProject({ config: { file: 'vite.config.ts', text: DECLARED_CONFIG } });
    writeFileSync(path.join(dir, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
    const { run, json } = report(dir);
    const named = doctor(dir, ['--json', '-p', 'tsconfig.build.json']);
    const namedJson = JSON.parse(named.stdout) as DoctorJson;
    expect(Array.isArray(namedJson.checks), `no checks in ${named.stdout}`).toBe(true);

    expect(run.status).toBe(0);
    expect(checkOf(json, 'tsconfig').message).toContain('tsconfig.json');
    expect(named.status).toBe(0);
    expect(checkOf(namedJson, 'tsconfig').message).toContain('tsconfig.build.json');
  });
});
