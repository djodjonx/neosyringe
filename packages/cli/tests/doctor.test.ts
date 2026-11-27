import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildDoctorReport,
  checkIntegration,
  checkPackageExports,
  checkPackages,
  checkTsconfig,
  checkTypescript,
  doctorResult,
  parseVersion,
  renderDoctorText,
  runDoctor,
  satisfies,
  type DoctorCheck,
  type InstalledPackage,
} from '../src/doctor';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'g07-doctor-unit-'));
  scratch.push(dir);
  return dir;
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

function installedAt(dir: string, name: string, json: Record<string, unknown>): InstalledPackage {
  const folder = path.join(dir, 'node_modules', ...name.split('/'));
  write(folder, 'package.json', JSON.stringify(json));
  return { name, dir: folder, json };
}

const check = (id: string, status: DoctorCheck['status'], remedy?: string): DoctorCheck => ({
  id,
  status,
  message: `${id} message`,
  ...(remedy !== undefined ? { remedy } : {}),
});

describe('G07 doctorResult', () => {
  it('G07-P6 an error gives exit code 1', () => {
    expect(doctorResult([check('a', 'ok'), check('b', 'error')]).exitCode).toBe(1);
  });

  it('G07-P7 a warning, an unknown and no check at all give exit code 0', () => {
    expect(doctorResult([check('a', 'warning'), check('b', 'unknown')]).exitCode).toBe(0);
    expect(doctorResult([]).exitCode).toBe(0);
  });

  it('G07-P5 the JSON report carries the schema version, the exit code and ok only when nothing is an error', () => {
    const failed = buildDoctorReport(doctorResult([check('a', 'error')]));
    const passed = buildDoctorReport(doctorResult([check('a', 'unknown')]));

    expect(failed).toMatchObject({ schemaVersion: 1, ok: false, exitCode: 1 });
    expect(passed).toMatchObject({ schemaVersion: 1, ok: true, exitCode: 0 });
    expect(passed.checks).toHaveLength(1);
  });

  it('G07-P7 the text prints every status as its own label, the fix under its check, and says what unknown means', () => {
    const text = renderDoctorText(doctorResult([
      check('one', 'ok'),
      check('two', 'warning', 'do this'),
      check('three', 'error'),
      check('four', 'unknown'),
    ]));

    expect(text).toMatch(/^ok\s+one: one message$/m);
    expect(text).toMatch(/^warning\s+two: two message$/m);
    expect(text).toContain('  Fix: do this');
    expect(text).toMatch(/^ERROR\s+three: three message$/m);
    expect(text).toMatch(/^unknown\s+four: four message$/m);
    expect(text).toContain('Result: 1 error, 1 warning, 1 unknown. Exit code 1. Unknown means doctor could not prove it: it is not a success.');
    expect(renderDoctorText(doctorResult([check('a', 'ok')]))).toContain('Result: 0 error, 0 warning, 0 unknown. Exit code 0.');
    expect(renderDoctorText(doctorResult([check('a', 'ok')]))).not.toContain('Unknown means');
  });
});

describe('G07 versions', () => {
  it('G07-P6 parseVersion reads the numeric core and nothing else', () => {
    expect(parseVersion('5.9.3')).toEqual([5, 9, 3]);
    expect(parseVersion('v5.9')).toEqual([5, 9, 0]);
    expect(parseVersion('5')).toEqual([5, 0, 0]);
    expect(parseVersion('5.0.0-beta.1')).toEqual([5, 0, 0]);
    expect(parseVersion('latest')).toBeUndefined();
    expect(parseVersion('workspace:*')).toBeUndefined();
    expect(parseVersion('')).toBeUndefined();
  });

  it('G07-P6 >= at its boundary: equal passes, one below fails, above passes', () => {
    expect(satisfies('5.0.0', '>=5.0.0')).toBe(true);
    expect(satisfies('4.9.9', '>=5.0.0')).toBe(false);
    expect(satisfies('5.0.1', '>=5.0.0')).toBe(true);
    expect(satisfies('6.0.0', '>= 5.0.0')).toBe(true);
    expect(satisfies('5.0.0-beta.1', '>=5.0.0')).toBeUndefined();
  });

  it('G07-P6 >, <=, < and an exact version', () => {
    expect(satisfies('5.0.0', '>5.0.0')).toBe(false);
    expect(satisfies('5.0.1', '>5.0.0')).toBe(true);
    expect(satisfies('5.0.0', '<=5.0.0')).toBe(true);
    expect(satisfies('5.0.1', '<=5.0.0')).toBe(false);
    expect(satisfies('4.9.9', '<5.0.0')).toBe(true);
    expect(satisfies('5.0.0', '<5.0.0')).toBe(false);
    expect(satisfies('3.2.0', '3.2.0')).toBe(true);
    expect(satisfies('3.2.1', '3.2.0')).toBe(false);
    expect(satisfies('3.2.0', '=3.2.0')).toBe(true);
  });

  it('G07-P6 ^ and ~ stop at the next breaking version', () => {
    expect(satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });

  it('G07-M1 a partial operand is read for >=, < and ^ only: ~, <=, > and a bare partial are undefined', () => {
    expect(satisfies('5.3.0', '>=5')).toBe(true);
    expect(satisfies('4.9.9', '>=5')).toBe(false);
    expect(satisfies('5.9.9', '<6')).toBe(true);
    expect(satisfies('6.0.0', '<6')).toBe(false);
    expect(satisfies('5.1.9', '<5.2')).toBe(true);
    expect(satisfies('5.2.0', '<5.2')).toBe(false);
    expect(satisfies('5.3.0', '^5')).toBe(true);
    expect(satisfies('6.0.0', '^5')).toBe(false);
    expect(satisfies('5.9.0', '^5.1')).toBe(true);
    expect(satisfies('5.0.9', '^5.1')).toBe(false);
    // semver: ^0 is <1.0.0 and ^0.0 is <0.1.0.
    expect(satisfies('0.9.9', '^0')).toBe(true);
    expect(satisfies('1.0.0', '^0')).toBe(false);
    expect(satisfies('0.0.9', '^0.0')).toBe(true);
    expect(satisfies('0.1.0', '^0.0')).toBe(false);
    // semver: ~5 is <6.0.0, <=5 is <6.0.0, >5 is >=6.0.0. Reading them as 5.0.0 gives the opposite answer.
    expect(satisfies('5.3.0', '~5')).toBeUndefined();
    expect(satisfies('5.1.0', '~5.1')).toBeUndefined();
    expect(satisfies('5.1.0', '<=5')).toBeUndefined();
    expect(satisfies('5.0.1', '>5')).toBeUndefined();
    expect(satisfies('5.0.1', '>5.0')).toBeUndefined();
    // A full operand keeps its meaning for every operator.
    expect(satisfies('5.0.1', '>5.0.0')).toBe(true);
    expect(satisfies('5.1.0', '~5.1.0')).toBe(true);
  });

  it('G07-M1 a pre-release version, or a range that names one, is undefined: semver orders it below its release', () => {
    expect(satisfies('5.0.0-beta.1', '>=5.0.0')).toBeUndefined();
    expect(satisfies('5.0.0-beta.1', '<5.0.0')).toBeUndefined();
    expect(satisfies('5.4.0-dev.20260101', '^5.0.0')).toBeUndefined();
    expect(satisfies('5.0.0', '>5.0.0-beta.1')).toBeUndefined();
    expect(satisfies('5.0.0+build.7', '>=5.0.0')).toBe(true);
  });

  it('G07-P6 a space is and, || is or', () => {
    expect(satisfies('5.5.0', '>=5.0.0 <6.0.0')).toBe(true);
    expect(satisfies('6.0.0', '>=5.0.0 <6.0.0')).toBe(false);
    expect(satisfies('4.0.0', '^4.0.0 || ^5.0.0')).toBe(true);
    expect(satisfies('5.1.0', '^4.0.0 || ^5.0.0')).toBe(true);
    expect(satisfies('6.0.0', '^4.0.0 || ^5.0.0')).toBe(false);
  });

  it('G07-P6 * and an empty range accept any version', () => {
    expect(satisfies('1.0.0', '*')).toBe(true);
    expect(satisfies('1.0.0', '')).toBe(true);
  });

  it('G07-P6 an unparseable range or version is undefined, never a guess', () => {
    expect(satisfies('5.0.0', 'workspace:*')).toBeUndefined();
    expect(satisfies('5.0.0', 'latest')).toBeUndefined();
    expect(satisfies('5.0.0', '1.0.0 - 2.0.0')).toBeUndefined();
    expect(satisfies('5.0.0', '>=x')).toBeUndefined();
    expect(satisfies('5.0.0', '5')).toBeUndefined();
    expect(satisfies('not-a-version', '>=5.0.0')).toBeUndefined();
    // A range that is true through another alternative stays true; a false one with an unreadable part is unknown.
    expect(satisfies('5.0.0', '>=5.0.0 || latest')).toBe(true);
    expect(satisfies('4.0.0', '>=5.0.0 || latest')).toBeUndefined();
  });
});

describe('G07 checkTypescript', () => {
  const ranges = [{ source: '@djodjonx/neosyringe-plugin', range: '>=5.0.0' }];

  it('G07-P5 a typescript inside every range is ok and names its version and where it was resolved', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '5.9.3' });
    const result = checkTypescript(dir, [...ranges, { source: '@djodjonx/neosyringe-cli', range: '>=5.0.0' }]);

    expect(result.status).toBe('ok');
    expect(result.message).toContain('typescript 5.9.3 (node_modules/typescript)');
    expect(result.message).toContain('>=5.0.0 by @djodjonx/neosyringe-plugin, >=5.0.0 by @djodjonx/neosyringe-cli');
  });

  it('G07-P6 a typescript below a range is an error with a remedy', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '4.9.5' });
    const result = checkTypescript(dir, ranges);

    expect(result.status).toBe('error');
    expect(result.message).toContain('4.9.5');
    expect(result.message).toContain('>=5.0.0 declared by @djodjonx/neosyringe-plugin');
    expect(result.remedy).toContain('>=5.0.0');
  });

  it('G07-P6 a typescript exactly at the lower bound is ok', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '5.0.0' });

    expect(checkTypescript(dir, ranges).status).toBe('ok');
  });

  it('G07-P6 a missing typescript is an error', () => {
    expect(checkTypescript(temp(), ranges)).toMatchObject({ id: 'typescript', status: 'error' });
  });

  it('G07-P7 an unparseable range is unknown', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '5.9.3' });
    const result = checkTypescript(dir, [{ source: 'x', range: 'workspace:*' }]);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('workspace:*');
  });

  it('G07-M1 a pre-release typescript is unknown and says so: it is not "a range doctor does not read"', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '5.4.0-dev.20260101' });
    const result = checkTypescript(dir, ranges);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('pre-release');
    expect(result.message).not.toContain('not one doctor reads');
  });

  it('G07-P7 no range to compare with is unknown, and an unreadable typescript version is unknown', () => {
    const dir = temp();
    installedAt(dir, 'typescript', { name: 'typescript', version: '5.9.3' });
    const odd = temp();
    installedAt(odd, 'typescript', { name: 'typescript' });

    expect(checkTypescript(dir, []).status).toBe('unknown');
    expect(checkTypescript(odd, ranges).status).toBe('unknown');
  });
});

describe('G07 checkPackages', () => {
  it('G07-P6 no NeoSyringe package is an error', () => {
    expect(checkPackages([], temp())).toMatchObject({ id: 'neosyringe-packages', status: 'error' });
  });

  it('G07-P5 packages whose dependency ranges are satisfied are ok and listed with their versions', () => {
    const dir = temp();
    const core = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core', version: '3.2.0' });
    const cli = installedAt(dir, '@djodjonx/neosyringe-cli', { name: '@djodjonx/neosyringe-cli', version: '0.4.1', dependencies: { '@djodjonx/neosyringe-core': '^3.0.0' } });
    const result = checkPackages([core, cli], dir);

    expect(result.status).toBe('ok');
    expect(result.message).toContain('@djodjonx/neosyringe-core@3.2.0, @djodjonx/neosyringe-cli@0.4.1.');
    expect(result.message).toContain('@djodjonx/neosyringe-cli needs @djodjonx/neosyringe-core ^3.0.0, resolved 3.2.0');
  });

  it('G07-P6 a dependency version outside the range is an error that names both versions', () => {
    const dir = temp();
    const core = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core', version: '2.9.9' });
    const cli = installedAt(dir, '@djodjonx/neosyringe-cli', { name: '@djodjonx/neosyringe-cli', version: '0.4.1', dependencies: { '@djodjonx/neosyringe-core': '^3.0.0' } });
    const result = checkPackages([core, cli], dir);

    expect(result.status).toBe('error');
    expect(result.message).toContain('@djodjonx/neosyringe-cli needs @djodjonx/neosyringe-core ^3.0.0, found 2.9.9');
  });

  it('G07-P7 a range doctor does not read (workspace:*) is unknown, not ok', () => {
    const dir = temp();
    const core = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core', version: '3.2.0' });
    const cli = installedAt(dir, '@djodjonx/neosyringe-cli', { name: '@djodjonx/neosyringe-cli', version: '0.4.1', dependencies: { '@djodjonx/neosyringe-core': 'workspace:*' } });
    const result = checkPackages([core, cli], dir);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('not proven');
  });

  it('G07-P7 a package with no version is unknown', () => {
    const dir = temp();
    const core = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core' });
    const cli = installedAt(dir, '@djodjonx/neosyringe-cli', { name: '@djodjonx/neosyringe-cli', version: '0.4.1', dependencies: { '@djodjonx/neosyringe-core': '^3.0.0' } });

    expect(checkPackages([core, cli], dir).status).toBe('unknown');
    expect(checkPackages([core], dir).message).toContain('@djodjonx/neosyringe-core@?.');
  });
});

/**
 * pnpm's isolated layout: the plugin is a symlink in the project, its real folder is in the store, and the packages it
 * needs sit next to that real folder, not in the project. Node resolves a dependency from the real path of its dependent.
 * `storeBase` outside the project is a linked package (`npm link`, a workspace): Node never looks in the project from there.
 */
function pnpmProject(dir: string, plugin: Record<string, unknown>, storeBase = path.join(dir, 'node_modules/.pnpm')): { store: string } {
  const store = path.join(storeBase, 'plugin@1.0.0/node_modules');
  const real = path.join(store, '@djodjonx/neosyringe-plugin');
  write(real, 'package.json', JSON.stringify({ name: '@djodjonx/neosyringe-plugin', version: '1.0.0', ...plugin }));
  mkdirSync(path.join(dir, 'node_modules/@djodjonx'), { recursive: true });
  symlinkSync(real, path.join(dir, 'node_modules/@djodjonx/neosyringe-plugin'), 'dir');
  return { store };
}

function packagesCheck(dir: string): DoctorCheck {
  const found = runDoctor({ cwd: dir }).checks.find((item) => item.id === 'neosyringe-packages');
  if (!found) throw new Error('doctor ran no neosyringe-packages check');
  return found;
}

const NEEDS_CORE = { dependencies: { '@djodjonx/neosyringe-core': '^3.0.0' } };

describe('G07 checkPackages resolves each dependency from the real path of its dependent', () => {
  it('G07-I2 core next to the real plugin and inside its range is ok, with the version that was read', () => {
    const dir = temp();
    const { store } = pnpmProject(dir, NEEDS_CORE);
    write(store, '@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '3.2.0' }));
    const result = packagesCheck(dir);

    expect(result.status).toBe('ok');
    expect(result.message).toContain('@djodjonx/neosyringe-plugin needs @djodjonx/neosyringe-core ^3.0.0, resolved 3.2.0');
  });

  it('G07-I2 core next to the real plugin but outside its range is an error, though core is not visible from the project', () => {
    const dir = temp();
    const { store } = pnpmProject(dir, NEEDS_CORE);
    write(store, '@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '2.9.9' }));
    const result = packagesCheck(dir);

    expect(result.status).toBe('error');
    expect(result.message).toContain('@djodjonx/neosyringe-plugin needs @djodjonx/neosyringe-core ^3.0.0, found 2.9.9');
  });

  it('G07-I2 a core the plugin cannot find is unknown, not ok', () => {
    const dir = temp();
    pnpmProject(dir, NEEDS_CORE);
    const result = packagesCheck(dir);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('@djodjonx/neosyringe-plugin needs @djodjonx/neosyringe-core ^3.0.0 and it cannot be found from');
  });

  it('G07-I2 a core in the project is not the proof when the plugin resolves another copy', () => {
    const dir = temp();
    const { store } = pnpmProject(dir, NEEDS_CORE);
    write(dir, 'node_modules/@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '3.2.0' }));
    write(store, '@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '2.9.9' }));

    expect(packagesCheck(dir)).toMatchObject({ status: 'error' });
    expect(packagesCheck(dir).message).toContain('found 2.9.9');
  });

  it('G07-I2 a core in the project that a linked plugin cannot see is unknown: the copy it resolves was not read', () => {
    const dir = temp();
    pnpmProject(dir, NEEDS_CORE, path.join(temp(), 'linked'));
    write(dir, 'node_modules/@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '3.2.0' }));

    expect(packagesCheck(dir).status).toBe('unknown');
  });

  it('G07-I2 a store inside the project still sees the project core, as Node does', () => {
    const dir = temp();
    pnpmProject(dir, NEEDS_CORE);
    write(dir, 'node_modules/@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '3.2.0' }));

    expect(packagesCheck(dir).status).toBe('ok');
  });

  it('G07-I2 a node_modules folder inside node_modules is not searched, as Node does', () => {
    const dir = temp();
    installedAt(dir, '@djodjonx/neosyringe-plugin', { name: '@djodjonx/neosyringe-plugin', version: '1.0.0', ...NEEDS_CORE });
    write(dir, 'node_modules/node_modules/@djodjonx/neosyringe-core/package.json', JSON.stringify({ name: '@djodjonx/neosyringe-core', version: '3.2.0' }));

    expect(packagesCheck(dir).status).toBe('unknown');
  });

  it('G07-I2 a package that declares no NeoSyringe dependency has nothing to match, and is ok', () => {
    const dir = temp();
    pnpmProject(dir, { dependencies: { unplugin: '^2.0.0' } });

    expect(packagesCheck(dir).status).toBe('ok');
  });
});

describe('G07 checkPackageExports', () => {
  it('G07-P7 nothing to check is unknown', () => {
    expect(checkPackageExports([])).toMatchObject({ id: 'package-exports', status: 'unknown' });
  });

  it('G07-M2 a package that names no export target proves nothing: unknown, never "all 0 are on disk"', () => {
    const dir = temp();
    const bare = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core', version: '3.2.0' });
    const patterns = installedAt(dir, '@djodjonx/neosyringe-ui', { name: '@djodjonx/neosyringe-ui', exports: { './*': './dist/*.mjs' } });
    const result = checkPackageExports([bare, patterns]);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('no export target');
    expect(result.message).not.toContain('all 0');
  });

  it('G07-P5 main, module, types, bin and every string of exports on disk are ok; patterns are skipped', () => {
    const dir = temp();
    const pkg = installedAt(dir, '@djodjonx/neosyringe-plugin', {
      name: '@djodjonx/neosyringe-plugin',
      main: 'dist/index.cjs',
      module: 'dist/index.mjs',
      types: 'dist/index.d.mts',
      bin: { tool: 'dist/bin.mjs' },
      exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' }, './*': './dist/*.mjs' },
    });
    for (const file of ['index.cjs', 'index.mjs', 'index.d.mts', 'bin.mjs']) write(pkg.dir, `dist/${file}`, '');
    const result = checkPackageExports([pkg]);

    expect(result.status).toBe('ok');
    expect(result.message).toBe('all 4 export targets of 1 package(s) are on disk.');
  });

  it('G07-P6 a target that is not on disk is an error that names the package and the target', () => {
    const dir = temp();
    const pkg = installedAt(dir, '@djodjonx/neosyringe-lsp', { name: '@djodjonx/neosyringe-lsp', main: 'dist/index.cjs', exports: { '.': { require: './dist/index.cjs' } } });
    const result = checkPackageExports([pkg]);

    expect(result.status).toBe('error');
    expect(result.message).toContain('1 of 1 export targets are not on disk: @djodjonx/neosyringe-lsp dist/index.cjs.');
  });

  it('G07-P6 a long list of missing targets is cut at ten and says how many more', () => {
    const dir = temp();
    const exportsMap = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`./e${index}`, `./dist/e${index}.mjs`]));
    const pkg = installedAt(dir, '@djodjonx/neosyringe-core', { name: '@djodjonx/neosyringe-core', exports: exportsMap });
    const result = checkPackageExports([pkg]);

    expect(result.status).toBe('error');
    expect(result.message).toContain('12 of 12 export targets are not on disk');
    expect(result.message).toContain('and 2 more');
  });
});

describe('G07 checkTsconfig', () => {
  it('G07-P5 a readable tsconfig is ok and shown relative to the working directory', () => {
    const dir = temp();
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
    write(dir, 'src/a.ts', 'export const a = 1;');
    const result = checkTsconfig(dir, undefined);

    expect(result.status).toBe('ok');
    expect(result.message).toBe('tsconfig.json is read (1 file(s) included).');
  });

  it('G07-P5 --project selects another tsconfig', () => {
    const dir = temp();
    write(dir, 'tsconfig.json', '{}');
    write(dir, 'tsconfig.build.json', JSON.stringify({ compilerOptions: { strict: true } }));

    expect(checkTsconfig(dir, 'tsconfig.build.json').message).toContain('tsconfig.build.json');
  });

  it('G07-P6 no tsconfig, a project path that does not exist and an unreadable file are errors', () => {
    const dir = temp();
    write(dir, 'broken.json', '{ "compilerOptions": ');

    expect(checkTsconfig(dir, undefined)).toMatchObject({ status: 'error', message: 'no tsconfig.json was found from the working directory.' });
    expect(checkTsconfig(dir, 'missing.json')).toMatchObject({ status: 'error', message: 'missing.json does not exist.' });
    expect(checkTsconfig(dir, 'broken.json')).toMatchObject({ status: 'error', message: 'broken.json cannot be read as a tsconfig.' });
  });

  it('G07-P6 a tsconfig with errors is an error that lists the TS codes and no option value', () => {
    const dir = temp();
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'SECRET_TARGET_VALUE' } }));
    const result = checkTsconfig(dir, undefined);

    expect(result.status).toBe('error');
    expect(result.message).toMatch(/^tsconfig\.json has \d+ error\(s\): TS\d+/);
    expect(result.message).not.toContain('SECRET_TARGET_VALUE');
    expect(result.remedy).toContain('tsc -p tsconfig.json --noEmit');
  });
});

describe('G07 checkIntegration', () => {
  it('G07-P7 no known config file is unknown', () => {
    const result = checkIntegration(temp());

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('no vite, rollup, webpack, rspack or nuxt config file');
  });

  it('G07-P5 a literal call is declared in the file, and the message says it is not proven to run', () => {
    const dir = temp();
    write(dir, 'webpack.config.js', "const { neoSyringePlugin } = require('@djodjonx/neosyringe-plugin');\nmodule.exports = { plugins: [neoSyringePlugin.webpack()] };\n");
    const result = checkIntegration(dir);

    expect(result.status).toBe('ok');
    expect(result.message).toContain('declared in webpack.config.js');
    expect(result.message).toContain('not proven');
    expect(result.message).not.toMatch(/\bactive\b/);
  });

  it('G07-P7 a call that is only in a comment is not a declaration', () => {
    const dir = temp();
    write(dir, 'vite.config.ts', "// plugins: [neoSyringePlugin.vite()]\n/* neoSyringePlugin.vite() */\nexport default { plugins: [] };\n");

    expect(checkIntegration(dir).status).toBe('warning');
  });

  it('G07-P7 a config that only names the package is unknown', () => {
    const dir = temp();
    write(dir, 'rollup.config.mjs', "import * as plugin from '@djodjonx/neosyringe-plugin';\nexport default { plugins: [] };\n");
    const result = checkIntegration(dir);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('rollup.config.mjs');
  });

  it('G07-P7 a dynamic plugin list or a computed require is unknown', () => {
    const spread = temp();
    write(spread, 'vite.config.ts', 'export default { plugins: [...makePlugins()] };\n');
    const computed = temp();
    write(computed, 'nuxt.config.ts', 'const name = pick();\nexport default { modules: [require(name)] };\n');
    const dynamicImport = temp();
    write(dynamicImport, 'rspack.config.js', 'module.exports = async () => ({ plugins: [(await import(path)).default()] });\n');

    expect(checkIntegration(spread).status).toBe('unknown');
    expect(checkIntegration(computed).status).toBe('unknown');
    expect(checkIntegration(dynamicImport).status).toBe('unknown');
  });

  it('G07-P7 a static config that never mentions the plugin is a warning with a remedy', () => {
    const dir = temp();
    write(dir, 'vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n");
    const result = checkIntegration(dir);

    expect(result.status).toBe('warning');
    expect(result.remedy).toContain('vite.config.ts');
  });

  it('G07-P7 a config file that cannot be read is unknown', () => {
    const dir = temp();
    mkdirSync(path.join(dir, 'vite.config.ts'));
    const result = checkIntegration(dir);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('cannot be read');
  });

  it('G07-P5 a declaration is found in any of the known files', () => {
    const dir = temp();
    write(dir, 'vite.config.ts', 'export default { plugins: [] };\n');
    write(dir, 'rollup.config.js', 'export default { plugins: [neoSyringePlugin.rollup()] };\n');

    expect(checkIntegration(dir).message).toContain('declared in rollup.config.js');
  });
});

describe('G07 runDoctor', () => {
  it('G07-P5 runs the five checks in order, read-only, on a project with a typescript and a tsconfig', () => {
    const dir = temp();
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['src'] }));
    write(dir, 'src/a.ts', 'export const a = 1;');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    symlinkSync(path.resolve(__dirname, '../../../node_modules/typescript'), path.join(dir, 'node_modules/typescript'));
    const result = runDoctor({ cwd: dir });

    expect(result.checks.map((item) => item.id)).toEqual(['typescript', 'neosyringe-packages', 'package-exports', 'tsconfig', 'integration']);
    expect(result.checks.find((item) => item.id === 'typescript')?.status).toBe('ok');
    expect(result.checks.find((item) => item.id === 'tsconfig')?.status).toBe('ok');
    expect(result.checks.find((item) => item.id === 'neosyringe-packages')?.status).toBe('error');
    expect(result.exitCode).toBe(1);
  });
});
