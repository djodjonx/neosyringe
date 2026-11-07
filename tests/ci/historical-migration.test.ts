import { describe, expect, it } from 'vitest';
import {
  assertBuildOutsideRepo,
  assertDiagnostic,
  assertExactPins,
  assertInstalledVersion,
  assertNoNestedDjodjonx,
  compareBehaviour,
} from '../../scripts/ci/lib/historical-compare.mjs';

// Offline checks for the historical migration helpers.
// The network script is scripts/ci/historical-migration.mjs. These tests do not install anything.

const same = { real: 'report from real', disposed: 0 };

describe('historical migration', () => {
  it('equal behaviour returns no difference', () => {
    expect(compareBehaviour(same, same, {})).toEqual([]);
  });

  it('undeclared difference throws naming the key', () => {
    expect(() => compareBehaviour({ a: 1 }, { a: 2 }, {})).toThrow(/undeclared difference: a/);
  });

  it('declared difference that does not occur throws', () => {
    expect(() => compareBehaviour({ a: 1 }, { a: 1 }, { a: { before: 1, after: 2 } })).toThrow(
      /declared difference did not occur: a/,
    );
  });

  it('declared difference with a wrong value throws', () => {
    expect(() => compareBehaviour({ a: 1 }, { a: 9 }, { a: { before: 1, after: 2 } })).toThrow(/a/);
  });

  it('a pin that is not exact is refused', () => {
    expect(() => assertExactPins('^0.3.0')).toThrow('refusing a pin that is not an exact version: ^0.3.0');
    expect(() => assertExactPins('~0.3.0')).toThrow('refusing a pin that is not an exact version: ~0.3.0');
    expect(() => assertExactPins('latest')).toThrow('refusing a pin that is not an exact version: latest');
    expect(() => assertExactPins('@djodjonx/neosyringe@^0.3.0')).toThrow(
      'refusing a pin that is not an exact version: @djodjonx/neosyringe@^0.3.0',
    );
    expect(assertExactPins('0.3.0')).toBeUndefined();
    expect(assertExactPins(['0.3.0', '@djodjonx/neosyringe@0.3.0'])).toBeUndefined();
  });

  it('an installed version other than the pin is refused', () => {
    expect(() => assertInstalledVersion('0.3.1', '0.3.0')).toThrow('installed version 0.3.1 is not pin 0.3.0');
  });

  it('assertDiagnostic requires the code', () => {
    expect(() => assertDiagnostic('build finished', 'NEO_FACTORY_DEPENDENCIES_REQUIRED')).toThrow(
      'missing diagnostic NEO_FACTORY_DEPENDENCIES_REQUIRED',
    );
    expect(assertDiagnostic('NEO_CONTAINER_DESTROYED: done', 'NEO_CONTAINER_DESTROYED')).toBe(
      'NEO_CONTAINER_DESTROYED: done',
    );
  });

  it('a build that omits projectRoot is refused', () => {
    expect(() => assertBuildOutsideRepo({
      projectRoot: '',
      paths: ['/tmp/proj/src/app.ts'],
      reads: ['/tmp/proj/src/app.ts'],
      ok: true,
    }, '/repo')).toThrow('build did not report projectRoot');
    expect(() => assertBuildOutsideRepo({
      paths: ['/tmp/proj/src/app.ts'],
      reads: ['/tmp/proj/src/app.ts'],
      ok: true,
    }, '/repo')).toThrow('build did not report projectRoot');
  });

  it('a successful build that reports no TypeScript read is refused', () => {
    expect(() => assertBuildOutsideRepo({
      projectRoot: '/tmp/proj',
      paths: ['/tmp/proj/src/app.ts'],
      reads: [],
      ok: true,
    }, '/repo')).toThrow('build did not report a TypeScript read');
    expect(() => assertBuildOutsideRepo({ projectRoot: '/tmp/proj', paths: [], ok: true }, '/repo')).toThrow(
      'build did not report a TypeScript read',
    );
  });

  it('a build that read a file under the repo is refused', () => {
    expect(() => assertBuildOutsideRepo({
      projectRoot: '/tmp/proj',
      paths: ['/tmp/proj/src/app.ts', '/repo/packages/neosyringe/src/index.ts'],
      reads: ['/tmp/proj/src/app.ts', '/repo/packages/neosyringe/src/index.ts'],
      ok: true,
    }, '/repo')).toThrow('build read a file under the repo: /repo/packages/neosyringe/src/index.ts');
    expect(() => assertBuildOutsideRepo({
      projectRoot: '/repo',
      paths: ['/tmp/proj/src/app.ts'],
      reads: ['/tmp/proj/src/app.ts'],
      ok: true,
    }, '/repo')).toThrow('build read a file under the repo: /repo');
  });

  it('a build whose files stay outside the repo is accepted', () => {
    expect(assertBuildOutsideRepo({
      projectRoot: '/tmp/proj',
      paths: ['/tmp/proj/src/app.ts', '/repo-extra/file.ts'],
      reads: ['/tmp/proj/src/app.ts'],
      ok: true,
    }, '/repo')).toBeUndefined();
    expect(assertBuildOutsideRepo({
      projectRoot: '/tmp/proj',
      paths: [],
      reads: [],
      ok: false,
    }, '/repo')).toBeUndefined();
  });

  it('a nested @djodjonx package is refused', () => {
    expect(() => assertNoNestedDjodjonx([
      'node_modules/@djodjonx/neosyringe-plugin/node_modules/@djodjonx/neosyringe-core/package.json',
    ])).toThrow(
      'nested @djodjonx package: node_modules/@djodjonx/neosyringe-plugin/node_modules/@djodjonx/neosyringe-core/package.json',
    );
    expect(() => assertNoNestedDjodjonx([
      'node_modules\\@djodjonx\\neosyringe-plugin\\node_modules\\@djodjonx\\neosyringe-core\\package.json',
    ])).toThrow(/nested @djodjonx package:/);
  });

  it('a flat @djodjonx install is accepted', () => {
    expect(assertNoNestedDjodjonx([])).toBeUndefined();
    expect(assertNoNestedDjodjonx([
      'node_modules/@djodjonx/neosyringe/package.json',
      'node_modules/@djodjonx/neosyringe-plugin/package.json',
    ])).toBeUndefined();
  });
});
