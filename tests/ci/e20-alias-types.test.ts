import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTarballFromBuild } from '../../scripts/ci/lib/tarball-proof.mjs';

/**
 * E20 `useExisting`, typed on the public surface. Each source is typechecked by the consumer-types harness against the
 * source of `@djodjonx/neosyringe` (P21). The same fixtures of tests/consumer-types are then typechecked against a
 * packed archive of the build on disk (P22): the archive is what a consumer installs.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const entry = path.join(root, 'packages/neosyringe/src/index.ts');
const packageDir = path.join(root, 'packages/neosyringe');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true,
    "types": [],
    "baseUrl": ".",
    "paths": { "@djodjonx/neosyringe": [${JSON.stringify(entry)}] }
  },
  "files": ["consumer.ts"]
}
`;

const PRELUDE = `
import {
  defineBuilderConfig,
  useInterface,
  useProperty,
  type Alias,
  type Container,
  type CoreContainer,
} from '@djodjonx/neosyringe';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
interface Logger { id: string }
interface Named { id: string; name: string }
interface Stranger { label: string }
class Service implements Named { id = 'service'; name = 'service'; }
class Other { other = 1; }
class Holder { retries = 0; }
const logger = useInterface<Logger>();
const named = useInterface<Named>();
const stranger = useInterface<Stranger>();
const retries = useProperty<number>(Holder, 'retries');
`;

interface Checked {
  status: number | null;
  output: string;
  errors: string[];
}

function check(source: string): Checked {
  const dir = temp('neosyringe-e20-');
  writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG);
  writeFileSync(path.join(dir, 'consumer.ts'), `${PRELUDE}${source}`);
  const run = spawnSync(process.execPath, [harness, dir], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
  return { status: run.status, output, errors };
}

/** `TS2345 line` of each error, in the order tsc lists them, the line counted in `source` (the prelude is cut). */
function where(errors: readonly string[], source: string): string[] {
  const offset = PRELUDE.split('\n').length - 1;
  const lines = source.split('\n');
  return errors.map((line) => {
    const match = /consumer\.ts\((\d+),\d+\): error (TS\d+)/.exec(line);
    const index = match ? Number(match[1]) - offset - 1 : -1;
    return `${match?.[2] ?? '?'} ${(lines[index] ?? '?').trim()}`;
  });
}

function run(args: readonly string[]) {
  const result = spawnSync(process.execPath, [harness, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

/** A real `pnpm pack` tarball of the build on disk. */
function packedArchive(): string {
  const dir = temp('neosyringe-e20-archive-');
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], { cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack made no tarball');
  const archive = path.join(dir, tarball);
  expect(assertTarballFromBuild(archive, packageDir).distFiles).toBeGreaterThan(0);
  return archive;
}

describe('E20 useExisting types', () => {
  it('E20-P21 a subtype, a tuple of aliases and the helper type are accepted and keep their value types', () => {
    const source = `
const root = defineBuilderConfig({
  name: 'Root',
  injections: [{ token: Service }, { token: logger, useExisting: Service }, { token: named, useExisting: Service }],
});
type _Root = Expect<Equal<typeof root, Container>>;
const viaLogger: Logger = root.resolve(logger);
const viaNamed: Named = root.resolve(named);
const many = root.resolveMany([logger, named, Service]);
type _Many = Expect<Equal<typeof many, [Logger, Named, Service]>>;
const chained = defineBuilderConfig({
  name: 'Chained',
  injections: [{ token: Service }, { token: named, useExisting: Service }, { token: logger, useExisting: named }, { token: Holder, scoped: true }],
});
type _Chained = Expect<Equal<typeof chained, Container>>;
const lean = defineBuilderConfig({ name: 'Lean', runtime: { profile: 'minimal' }, injections: [{ token: Service }, { token: logger, useExisting: Service }] });
type _Lean = Expect<Equal<typeof lean, CoreContainer>>;
const same: Alias<typeof logger, typeof Service> = { token: logger, useExisting: Service };
const wide: Alias<typeof Service, typeof Service> = { token: Service, useExisting: Service };
void viaLogger; void viaNamed; void same; void wide;
`;
    const { errors } = check(source);
    expect(errors).toEqual([]);
  });

  it('E20-P21 a wrong value type, an alias with a provider or with multi, and the helper type on a wrong pair are refused', () => {
    const source = `
defineBuilderConfig({ name: 'Control', injections: [{ token: Service }, { token: logger, useExisting: Service }] });
defineBuilderConfig({ name: 'WrongType', injections: [{ token: Service }, { token: stranger, useExisting: Service }] });
defineBuilderConfig({ name: 'WithProvider', injections: [{ token: Service }, { token: logger, useExisting: Service, provider: Service }] });
defineBuilderConfig({ name: 'WithMulti', injections: [{ token: Service }, { token: logger, useExisting: Service, multi: true }] });
defineBuilderConfig({ name: 'WithLifecycle', injections: [{ token: Service }, { token: logger, useExisting: Service, lifecycle: 'transient' }] });
const helper: Alias<typeof Service, typeof Other> = { token: Service, useExisting: Other };
defineBuilderConfig({ name: 'Property', injections: [{ token: Service }, { token: retries, useExisting: Service }] });
void helper;
`;
    const { errors } = check(source);
    expect(where(errors, source)).toEqual([
      "TS2769 defineBuilderConfig({ name: 'WrongType', injections: [{ token: Service }, { token: stranger, useExisting: Service }] });",
      "TS2769 defineBuilderConfig({ name: 'WithProvider', injections: [{ token: Service }, { token: logger, useExisting: Service, provider: Service }] });",
      "TS2769 defineBuilderConfig({ name: 'WithMulti', injections: [{ token: Service }, { token: logger, useExisting: Service, multi: true }] });",
      "TS2769 defineBuilderConfig({ name: 'WithLifecycle', injections: [{ token: Service }, { token: logger, useExisting: Service, lifecycle: 'transient' }] });",
      'TS2322 const helper: Alias<typeof Service, typeof Other> = { token: Service, useExisting: Other };',
      "TS2769 defineBuilderConfig({ name: 'Property', injections: [{ token: Service }, { token: retries, useExisting: Service }] });",
    ]);
  });

  it('E20-P21 override and overrideMany keep their types: the alias is refused at run time, not by the type', () => {
    const source = `
const root = defineBuilderConfig({ name: 'Override', injections: [{ token: Service }, { token: logger, useExisting: Service }] });
const one: Promise<void> = root.override(Service, () => new Service());
const many: Promise<void> = root.overrideMany([[Service, () => new Service()]]);
void one; void many;
`;
    const { errors } = check(source);
    expect(errors).toEqual([]);
  });

  it('E20-P22 the positive fixtures, alias.ts and public-api.ts included, pass against the packed archive', () => {
    const result = run(['tests/consumer-types/positive', '--pack', packedArchive()]);
    expect(result.output).toContain('from=archive');
    expect(result.status, result.output).toBe(0);
  }, 180_000);

  it('E20-P22 the negative fixtures report every pinned alias and public-api line from the archive, and an unpinned line fails', () => {
    const archive = packedArchive();
    const real = run(['tests/consumer-types/negative', '--expect-file', 'expected-diagnostic.txt', '--pack', archive]);
    expect(real.status, real.output).toBe(0);
    const extra = path.join(temp('neosyringe-e20-expect-'), 'missing.txt');
    writeFileSync(extra, "alias.ts(26,5): error TS9999: not reported\n");
    const missing = run(['tests/consumer-types/negative', '--expect-file', extra, '--pack', archive]);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('TS9999');
  }, 180_000);
});
