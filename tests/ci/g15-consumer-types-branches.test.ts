import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The two error branches that the `--package ui` option added to the consumer-types harness: an unknown package name,
 * and a package folder that declares no types for the `./serialize` export. Neither needs a build.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const positive = 'tests/consumer-types/ui-serialize/positive';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [harness, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

/** A package folder holding the given `package.json` text, or none. */
function folder(manifest: string | undefined): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-g15-branches-'));
  dirs.push(dir);
  if (manifest !== undefined) writeFileSync(path.join(dir, 'package.json'), manifest);
  return dir;
}

describe('G15 consumer-types branches', () => {
  it.each([
    { label: 'a name that is not a package', args: ['--package', 'nope'], shown: 'nope' },
    { label: 'a name inherited from Object.prototype', args: ['--package', 'constructor'], shown: 'constructor' },
    { label: 'no value after the option', args: ['--package'], shown: '' },
  ])('an unknown --package exits 1 and names the packages ($label)', ({ args, shown }) => {
    const result = run([positive, ...args]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`unknown --package ${shown}: expected neosyringe or ui`);
  });

  it('a package folder with no types for the export exits 1 and names the manifest and the export', () => {
    const withoutExport = folder(JSON.stringify({ name: 'x', exports: { '.': { types: './index.d.ts' } } }));
    const result = run([positive, '--package', 'ui', '--pack', withoutExport]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${path.join(withoutExport, 'package.json')} declares no types for the export ./serialize`);
  });

  it('a package folder with no package.json exits 1 with the same message', () => {
    const empty = folder(undefined);
    const result = run([positive, '--package', 'ui', '--pack', empty]);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${path.join(empty, 'package.json')} declares no types for the export ./serialize`);
  });

  it('a package folder that declares the types for the export typechecks the consumer', () => {
    const types = path.join(root, 'packages/ui/src/serialize.ts');
    const declared = folder(JSON.stringify({ name: 'x', exports: { './serialize': { types } } }));
    const result = run([positive, '--package', 'ui', '--pack', declared]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('ok from=folder');
  });
});
