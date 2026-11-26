import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * E16 `overrideMany`, typed on the public surface. Each source is typechecked by the consumer-types harness against the
 * source of `@djodjonx/neosyringe`. The packed archive is checked by the fixtures under tests/consumer-types.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const entry = path.join(root, 'packages/neosyringe/src/index.ts');

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
import { defineBuilderConfig, useInterface, type Container, type CoreContainer, type Token } from '@djodjonx/neosyringe';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
class Mail { send(): string { return 'sent'; } }
class Sms { text = 'sms'; }
interface Clock { now(): number }
const clock = useInterface<Clock>();
declare const box: Container;
declare const core: CoreContainer;
`;

interface Checked {
  status: number | null;
  output: string;
  errors: string[];
}

function check(source: string): Checked {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-e16-'));
  try {
    writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG);
    writeFileSync(path.join(dir, 'consumer.ts'), `${PRELUDE}${source}`);
    const run = spawnSync(process.execPath, [harness, dir], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
    return { status: run.status, output, errors };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codes(errors: readonly string[]): (string | undefined)[] {
  return errors.map((line) => /error (TS\d+)/.exec(line)?.[1]);
}

describe('E16 overrideMany types', () => {
  it('E16-P1 a tuple, a readonly tuple, a coherent union, the empty list and a scope compile and answer Promise<void>', () => {
    const { errors } = check(`
const done = box.overrideMany([[Mail, () => new Mail()], [clock, () => ({ now: () => 1 })]]);
type _Done = Expect<Equal<typeof done, Promise<void>>>;
const frozen = [[Mail, () => new Mail()], [clock, () => ({ now: () => 2 })]] as const;
const fromFrozen = box.overrideMany(frozen);
type _Frozen = Expect<Equal<typeof fromFrozen, Promise<void>>>;
declare const coherent: ReadonlyArray<readonly [typeof Mail, () => Mail] | readonly [Token<Clock>, () => Clock]>;
const fromUnion = box.overrideMany(coherent);
type _Union = Expect<Equal<typeof fromUnion, Promise<void>>>;
const none = box.overrideMany([]);
type _None = Expect<Equal<typeof none, Promise<void>>>;
const fromScope = box.createScope().overrideMany([[Mail, () => new Mail()]]);
type _Scope = Expect<Equal<typeof fromScope, Promise<void>>>;
`);
    expect(errors).toEqual([]);
  });

  it('E16-P2 a wrong return type, a union of incoherent pairs and a value that is not a token are refused; minimal has no method', () => {
    const { errors } = check(`
box.overrideMany([[Mail, () => 42]]);
declare const incoherent: ReadonlyArray<readonly [typeof Mail, () => Mail] | readonly [Token<Clock>, () => Mail]>;
box.overrideMany(incoherent);
box.overrideMany([[42, () => 1]]);
const minimal = defineBuilderConfig({ name: 'E16', runtime: { profile: 'minimal' }, injections: [{ token: Mail }] });
minimal.overrideMany([]);
core.overrideMany([]);
`);
    expect(codes(errors)).toEqual(['TS2345', 'TS2345', 'TS2322', 'TS2339', 'TS2339']);
  });
});
