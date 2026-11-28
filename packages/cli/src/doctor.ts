/**
 * `neosyringe-check doctor`: a read-only look at the environment.
 *
 * It reads package.json files, the tsconfig and the text of the known bundler config files. It never runs the
 * application, never resolves an application service, never writes a file, and prints only check ids, versions,
 * file names and sentences of its own: no config literal, no environment value, no factory source.
 * A fact it cannot prove is `unknown`, never `ok`.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectConfig } from '@djodjonx/neosyringe-core/analyzer';

export type DoctorStatus = 'ok' | 'warning' | 'error' | 'unknown';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly remedy?: string;
}

export interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
  /** 1 when a check is an `error`. `warning` and `unknown` do not fail the run: they are printed. */
  readonly exitCode: 0 | 1;
}

/** Version of the `doctor --json` report. Bump on a breaking change of its shape. */
export const DOCTOR_SCHEMA_VERSION = 1;

export interface DoctorReport {
  schemaVersion: 1;
  /** True when no check is an error. Unknown and warning checks are still in `checks`. */
  ok: boolean;
  exitCode: 0 | 1;
  checks: DoctorCheck[];
}

export function doctorResult(checks: readonly DoctorCheck[]): DoctorResult {
  return { checks, exitCode: checks.some((check) => check.status === 'error') ? 1 : 0 };
}

export function buildDoctorReport(result: DoctorResult): DoctorReport {
  return { schemaVersion: DOCTOR_SCHEMA_VERSION, ok: result.exitCode === 0, exitCode: result.exitCode, checks: [...result.checks] };
}

const STATUS_LABEL: Record<DoctorStatus, string> = { ok: 'ok', warning: 'warning', error: 'ERROR', unknown: 'unknown' };

/** The text report: one line per check, its fix under it, then a summary that says what `unknown` means. */
export function renderDoctorText(result: DoctorResult): string {
  const lines = ['NeoSyringe doctor'];
  for (const check of result.checks) {
    lines.push(`${STATUS_LABEL[check.status].padEnd(8)} ${check.id}: ${check.message}`);
    if (check.remedy) lines.push(`  Fix: ${check.remedy}`);
  }
  const count = (status: DoctorStatus): number => result.checks.filter((check) => check.status === status).length;
  const unknown = count('unknown');
  lines.push('');
  lines.push(
    `Result: ${count('error')} error, ${count('warning')} warning, ${unknown} unknown. Exit code ${result.exitCode}.`
    + (unknown > 0 ? ' Unknown means doctor could not prove it: it is not a success.' : ''),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Versions: the smallest satisfier the checks need (no dependency). A pre-release is never compared.
// ---------------------------------------------------------------------------

type Version = readonly [number, number, number];

/** A pre-release tag right after the numeric core (`5.0.0-beta.1`). Build metadata (`5.0.0+sha`) is not one. */
const PRERELEASE = /^\s*[=v^~<>]*\d+(?:\.\d+){0,2}-/;

export function isPrerelease(text: string): boolean {
  return PRERELEASE.test(text);
}

/** `5.9.3`, `v5.9`, `5`, `5.0.0-beta.1`: the numeric core, missing parts are 0. `undefined` when there is none. */
export function parseVersion(text: string): Version | undefined {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?\s*$/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Operators whose partial operand (`5`, `5.1`) means the same as that operand filled with zeros, or is handled below. */
const PARTIAL_OPERATORS: readonly string[] = ['>=', '<', '^'];

/**
 * True, false, or `undefined` when the comparator is not one this satisfier reads: a pre-release operand, and a partial
 * operand (`5`, `5.1`) with any operator but `>=`, `<` and `^`. In semver `~5` is `<6.0.0`, `<=5` is `<6.0.0` and
 * `>5` is `>=6.0.0`: reading them as `5.0.0` would give the opposite answer.
 */
function satisfiesComparator(version: Version, comparator: string): boolean | undefined {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(comparator);
  const operator = match?.[1] ?? '';
  const operand = match?.[2] ?? '';
  if (operand === '*' || operand.toLowerCase() === 'x') return operator === '' ? true : undefined;
  if (isPrerelease(operand)) return undefined;
  const target = parseVersion(operand);
  if (!target) return undefined;
  const parts = operand.replace(/^\s*v/, '').split('+')[0]?.split('.').length ?? 3;
  if (parts < 3 && !PARTIAL_OPERATORS.includes(operator)) return undefined;
  switch (operator) {
    case '>=': return compare(version, target) >= 0;
    case '>': return compare(version, target) > 0;
    case '<=': return compare(version, target) <= 0;
    case '<': return compare(version, target) < 0;
    case '^': {
      // The first non-zero part is bumped; a partial operand (`^0`, `^0.0`) stops at its last given part.
      const upper: Version =
        target[0] > 0 ? [target[0] + 1, 0, 0]
          : parts === 1 ? [1, 0, 0]
            : target[1] > 0 ? [0, target[1] + 1, 0]
              : parts === 2 ? [0, 1, 0]
                : [0, 0, target[2] + 1];
      return compare(version, target) >= 0 && compare(version, upper) < 0;
    }
    case '~': return compare(version, target) >= 0 && compare(version, [target[0], target[1] + 1, 0]) < 0;
    default: return compare(version, target) === 0;
  }
}

/**
 * Whether `version` satisfies `range`: comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`, exact) joined by spaces (and)
 * and `||` (or). `undefined` when either side is not something this reads (`workspace:*`, a hyphen range, a tag,
 * a pre-release): the caller reports `unknown`, never a guess.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version);
  if (!parsed || isPrerelease(version)) return undefined;
  const alternatives = range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split('||').map((part) => part.trim());
  let sawUnknown = false;
  for (const alternative of alternatives) {
    if (alternative === '') return true;
    let all = true;
    for (const comparator of alternative.split(/\s+/)) {
      const result = satisfiesComparator(parsed, comparator);
      if (result === undefined) {
        sawUnknown = true;
        all = false;
        break;
      }
      if (!result) all = false;
    }
    if (all) return true;
  }
  return sawUnknown ? undefined : false;
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

const NEOSYRINGE_PACKAGES = [
  '@djodjonx/neosyringe',
  '@djodjonx/neosyringe-plugin',
  '@djodjonx/neosyringe-core',
  '@djodjonx/neosyringe-ui',
  '@djodjonx/neosyringe-lsp',
  '@djodjonx/neosyringe-cli',
] as const;

const PLUGIN = '@djodjonx/neosyringe-plugin';

export interface InstalledPackage {
  readonly name: string;
  readonly dir: string;
  readonly json: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * The nearest `node_modules/<name>` from `start` upwards, as Node looks for a package: a folder that is itself named
 * `node_modules` is skipped. Nothing is executed.
 */
function findInstalled(name: string, start: string): InstalledPackage | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (path.basename(current) !== 'node_modules') {
      const dir = path.join(current, 'node_modules', ...name.split('/'));
      const json = readJsonFile(path.join(dir, 'package.json'));
      if (json) return { name, dir, json };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The folder Node resolves from: the real path of a package, so a symlink into a store resolves next to the store. */
function realDirOf(installed: InstalledPackage): string {
  try {
    return realpathSync(installed.dir);
  } catch {
    return installed.dir;
  }
}

/** The package `dependent` loads for `name`: looked up from the real path of `dependent`, as Node does. */
function resolveFrom(dependent: InstalledPackage, name: string): InstalledPackage | undefined {
  return findInstalled(name, realDirOf(dependent));
}

function versionOf(installed: InstalledPackage): string | undefined {
  return asString(installed.json.version);
}

/** The package.json of this CLI, next to `dist/` in a published package and next to `src/` in the repository. */
function ownPackage(): InstalledPackage | undefined {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const json = readJsonFile(path.join(dir, 'package.json'));
  return json ? { name: asString(json.name) ?? '@djodjonx/neosyringe-cli', dir, json } : undefined;
}

function shown(cwd: string, target: string): string {
  return path.relative(cwd, target).split(path.sep).join('/') || '.';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface SupportedRange {
  readonly source: string;
  readonly range: string;
}

/** The typescript range the product declares: the resolved plugin's peer range and the CLI's own. */
function supportedRanges(installed: readonly InstalledPackage[], own: InstalledPackage | undefined): SupportedRange[] {
  const found: SupportedRange[] = [];
  const plugin = installed.find((item) => item.name === PLUGIN);
  const pluginRange = asString(asRecord(plugin?.json.peerDependencies)?.typescript);
  if (plugin && pluginRange) found.push({ source: PLUGIN, range: pluginRange });
  const ownRange = asString(asRecord(own?.json.peerDependencies)?.typescript);
  if (own && ownRange) found.push({ source: own.name, range: ownRange });
  return found;
}

export function checkTypescript(cwd: string, ranges: readonly SupportedRange[]): DoctorCheck {
  const typescript = findInstalled('typescript', cwd);
  if (!typescript) {
    return {
      id: 'typescript',
      status: 'error',
      message: 'typescript is not installed in this project or above it.',
      remedy: 'Install it: npm install -D typescript',
    };
  }
  const version = versionOf(typescript);
  const where = shown(cwd, typescript.dir);
  if (version === undefined || parseVersion(version) === undefined) {
    return { id: 'typescript', status: 'unknown', message: `${where} has no readable version.` };
  }
  if (isPrerelease(version)) {
    return { id: 'typescript', status: 'unknown', message: `typescript ${version} (${where}) is a pre-release: doctor does not compare a pre-release with a range.` };
  }
  if (ranges.length === 0) {
    return { id: 'typescript', status: 'unknown', message: `typescript ${version} (${where}); no supported range was found to compare it with.` };
  }
  const verdicts = ranges.map((item) => ({ ...item, verdict: satisfies(version, item.range) }));
  const below = verdicts.find((item) => item.verdict === false);
  if (below) {
    return {
      id: 'typescript',
      status: 'error',
      message: `typescript ${version} (${where}) is outside the supported range ${below.range} declared by ${below.source}.`,
      remedy: `Install a typescript that satisfies ${below.range}: npm install -D typescript@latest`,
    };
  }
  const unreadable = verdicts.find((item) => item.verdict === undefined);
  if (unreadable) {
    return {
      id: 'typescript',
      status: 'unknown',
      message: `typescript ${version} (${where}); the range ${unreadable.range} declared by ${unreadable.source} is not one doctor reads.`,
    };
  }
  const declared = [...new Set(verdicts.map((item) => `${item.range} by ${item.source}`))].join(', ');
  return { id: 'typescript', status: 'ok', message: `typescript ${version} (${where}) satisfies ${declared}.` };
}

export function checkPackages(installed: readonly InstalledPackage[], cwd: string): DoctorCheck {
  if (installed.length === 0) {
    return {
      id: 'neosyringe-packages',
      status: 'error',
      message: 'no NeoSyringe package is installed in this project or above it.',
      remedy: 'Install the runtime and the build plugin: npm install @djodjonx/neosyringe && npm install -D @djodjonx/neosyringe-plugin',
    };
  }
  const versions = installed.map((item) => ({ item, version: versionOf(item) }));
  const list = versions.map(({ item, version }) => `${item.name}@${version ?? '?'}`).join(', ');
  const wrong: string[] = [];
  const unproven: string[] = [];
  const proof: string[] = [];
  for (const item of installed) {
    const dependencies = asRecord(item.json.dependencies) ?? {};
    for (const name of Object.keys(dependencies).filter((key) => key.startsWith('@djodjonx/'))) {
      const range = asString(dependencies[name]);
      if (range === undefined) continue;
      const needs = `${item.name} needs ${name} ${range}`;
      // From the real path of the dependent, not from the working directory: the copy found there may not be the one it loads.
      const dependency = resolveFrom(item, name);
      if (!dependency) {
        unproven.push(`${needs} and it cannot be found from ${shown(cwd, realDirOf(item))}`);
        continue;
      }
      const found = versionOf(dependency);
      const verdict = found === undefined ? undefined : satisfies(found, range);
      if (verdict === false) wrong.push(`${needs}, found ${found ?? 'no version'} (${shown(cwd, dependency.dir)})`);
      else if (verdict === undefined) unproven.push(`${needs}, found ${found ?? 'no version'}, which doctor cannot compare with that range`);
      else proof.push(`${needs}, resolved ${found ?? '?'} (${shown(cwd, dependency.dir)})`);
    }
  }
  if (wrong.length > 0) {
    return {
      id: 'neosyringe-packages',
      status: 'error',
      message: `${list}. ${wrong.join('; ')}.`,
      remedy: 'Install matching versions of the NeoSyringe packages: one lockfile, one version of @djodjonx/neosyringe-core.',
    };
  }
  if (unproven.length > 0) {
    return {
      id: 'neosyringe-packages',
      status: 'unknown',
      message: `${list}. A dependency match is not proven: ${unproven.join('; ')}.`,
    };
  }
  const checked = proof.length > 0
    ? `Read from the real path of each package: ${proof.join('; ')}.`
    : 'No installed package declares a NeoSyringe dependency to match.';
  return { id: 'neosyringe-packages', status: 'ok', message: `${list}. ${checked}` };
}

/** Every file target a package.json names (`./a` and `a` are one), from main, module, types, bin and each string of exports. Patterns are skipped. */
function exportTargets(json: Record<string, unknown>): string[] {
  const targets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else Object.values(asRecord(value) ?? {}).forEach(collect);
  };
  for (const field of ['main', 'module', 'types', 'bin', 'exports']) collect(json[field]);
  return [...new Set(targets.map((target) => path.posix.normalize(target)))].filter((target) => !target.includes('*'));
}

export function checkPackageExports(installed: readonly InstalledPackage[]): DoctorCheck {
  if (installed.length === 0) {
    return { id: 'package-exports', status: 'unknown', message: 'no NeoSyringe package was resolved, so there is no export to check.' };
  }
  const missing: string[] = [];
  let checked = 0;
  for (const item of installed) {
    for (const target of exportTargets(item.json)) {
      checked += 1;
      if (!existsSync(path.resolve(item.dir, target))) missing.push(`${item.name} ${target}`);
    }
  }
  if (missing.length > 0) {
    const shownMissing = missing.slice(0, 10).join(', ');
    return {
      id: 'package-exports',
      status: 'error',
      message: `${missing.length} of ${checked} export targets are not on disk: ${shownMissing}${missing.length > 10 ? `, and ${missing.length - 10} more` : ''}.`,
      remedy: 'Reinstall the package: its archive or its build is incomplete.',
    };
  }
  if (checked === 0) {
    return { id: 'package-exports', status: 'unknown', message: `no export target is named by the ${installed.length} package(s): nothing was checked.` };
  }
  return { id: 'package-exports', status: 'ok', message: `all ${checked} export targets of ${installed.length} package(s) are on disk.` };
}

export function checkTsconfig(cwd: string, project: string | undefined): DoctorCheck {
  const remedy = 'Run from the project folder, or pass --project <path>.';
  if (project !== undefined && !existsSync(path.resolve(cwd, project))) {
    return { id: 'tsconfig', status: 'error', message: `${project} does not exist.`, remedy };
  }
  try {
    const resolved = resolveProjectConfig(cwd, project, 'Use --project <path>.');
    const where = shown(cwd, resolved.configPath);
    if (resolved.parseErrors.length > 0) {
      const codes = [...new Set(resolved.parseErrors.map((error) => `TS${error.code}`))].join(', ');
      return {
        id: 'tsconfig',
        status: 'error',
        message: `${where} has ${resolved.parseErrors.length} error(s): ${codes}.`,
        remedy: `Run: npx tsc -p ${where} --noEmit to read them.`,
      };
    }
    return { id: 'tsconfig', status: 'ok', message: `${where} is read (${resolved.fileNames.length} file(s) included).` };
  } catch {
    return {
      id: 'tsconfig',
      status: 'error',
      message: project === undefined ? 'no tsconfig.json was found from the working directory.' : `${project} cannot be read as a tsconfig.`,
      remedy,
    };
  }
}

const CONFIG_BASES = ['vite', 'rollup', 'webpack', 'rspack', 'nuxt'] as const;
const CONFIG_EXTENSIONS = ['ts', 'js', 'mjs', 'mts', 'cjs'] as const;
const PLUGIN_CALL = /neoSyringePlugin\s*\.\s*[a-z]+\s*\(/;
const PLUGIN_SPECIFIER = /@djodjonx\/neosyringe-plugin/;
// A plugin list built by a spread, or a module loaded by a name that is not a literal: not provable by reading.
const DYNAMIC = /\brequire\s*\(\s*[^'"\s)]|\bimport\s*\(\s*[^'"\s)]|plugins\s*:\s*\[\s*\.\.\./;

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * Whether a known bundler config file declares the plugin. The files are read as text and never run, so
 * `ok` means "declared in <file>", never "active": that the plugin runs in a build is not proven here.
 */
export function checkIntegration(cwd: string): DoctorCheck {
  const files = CONFIG_BASES.flatMap((base) => CONFIG_EXTENSIONS.map((extension) => `${base}.config.${extension}`))
    .filter((file) => existsSync(path.join(cwd, file)));
  if (files.length === 0) {
    return {
      id: 'integration',
      status: 'unknown',
      message: `no vite, rollup, webpack, rspack or nuxt config file in the working directory. An esbuild script or a ts-patch setup is not inspected.`,
      remedy: 'Run neosyringe-check to validate the graph; doctor cannot tell how this project builds.',
    };
  }
  const read = files.map((file) => {
    try {
      return { file, text: withoutComments(readFileSync(path.join(cwd, file), 'utf8')) };
    } catch {
      return { file, text: undefined };
    }
  });
  const declared = read.find((item) => item.text !== undefined && PLUGIN_CALL.test(item.text));
  if (declared) {
    return {
      id: 'integration',
      status: 'ok',
      message: `declared in ${declared.file}: a literal neoSyringePlugin call is there. Doctor reads the file and does not run it: that the plugin executes in a build is not proven.`,
    };
  }
  const unprovable = read.find((item) => item.text === undefined || PLUGIN_SPECIFIER.test(item.text) || DYNAMIC.test(item.text));
  if (unprovable) {
    return {
      id: 'integration',
      status: 'unknown',
      message: `${unprovable.file} ${unprovable.text === undefined ? 'cannot be read' : 'does not show a literal neoSyringePlugin.<bundler>() call (it names the package, or builds its plugin list dynamically)'}: whether the plugin is declared is not proven.`,
      remedy: 'Write the call literally in the plugins of the config, or check a build.',
    };
  }
  return {
    id: 'integration',
    status: 'warning',
    message: `${files.join(', ')} found, none declares the NeoSyringe plugin.`,
    remedy: `Add neoSyringePlugin.<bundler>() from @djodjonx/neosyringe-plugin to the plugins of ${files[0] ?? 'the config'}.`,
  };
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly project?: string;
}

/** Runs every check. Reads package.json files, the tsconfig and bundler config text; writes nothing. */
export function runDoctor(options: DoctorOptions): DoctorResult {
  const installed = NEOSYRINGE_PACKAGES.flatMap((name) => findInstalled(name, options.cwd) ?? []);
  const ranges = supportedRanges(installed, ownPackage());
  return doctorResult([
    checkTypescript(options.cwd, ranges),
    checkPackages(installed, options.cwd),
    checkPackageExports(installed),
    checkTsconfig(options.cwd, options.project),
    checkIntegration(options.cwd),
  ]);
}
