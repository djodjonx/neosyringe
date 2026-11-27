import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Consumers of `@djodjonx/neosyringe-ui/serialize` read its types from the source mapping and from the packed archive.
 * The positive fixture imports the two serializers and their six types. The negative one imports two renderers, which
 * the light entry must not export. The archive runs need a fresh `pnpm build`: `--pack` refuses a stale dist.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const positive = 'tests/consumer-types/ui-serialize/positive';
const negative = 'tests/consumer-types/ui-serialize/negative';

function run(args: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [harness, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('G15 serialize types', () => {
  it('positive consumer typechecks from source', () => {
    const result = run([positive, '--package', 'ui']);
    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it('positive consumer typechecks from the packed archive', () => {
    const result = run([positive, '--package', 'ui', '--pack']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/ok from=archive \S*neosyringe-ui\S*\.tgz types=\S*dist\/serialize\.d\.mts/);
  }, 180_000);

  it('negative consumer fails with TS2305 from source', () => {
    const result = run([negative, '--package', 'ui', '--expect-file', 'expected-diagnostic.txt']);
    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it('negative consumer fails with TS2305 from the packed archive', () => {
    const result = run([negative, '--package', 'ui', '--expect-file', 'expected-diagnostic.txt', '--pack']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/ok from=archive \S*neosyringe-ui\S*\.tgz types=\S*dist\/serialize\.d\.mts/);
  }, 180_000);
});
