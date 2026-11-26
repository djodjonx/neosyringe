import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * E17 `resolveMany`, typed on the public surface. Each source is typechecked by the consumer-types harness against the
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
import { defineBuilderConfig, useInterface, useProperty, type Container, type CoreContainer, type FactoryContext, type Token } from '@djodjonx/neosyringe';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
class Mail { send(): string { return 'sent'; } }
class Sms { text = 'sms'; }
interface Clock { now(): number }
const clock = useInterface<Clock>();
const retries = useProperty<number>(Mail, 'retries');
declare const box: Container;
declare const core: CoreContainer;
declare const context: FactoryContext;
declare const flag: boolean;
`;

interface Checked {
  status: number | null;
  output: string;
  errors: string[];
}

function check(source: string): Checked {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-e17-'));
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

describe('E17 resolveMany types', () => {
  it('E17-P12 a heterogeneous tuple of class, interface and property tokens has one value type per position', () => {
    const { errors } = check(`
const tuple = box.resolveMany([Mail, clock, retries, Sms]);
type _Tuple = Expect<Equal<typeof tuple, [Mail, Clock, number, Sms]>>;
const first: Mail = tuple[0];
const second: Clock = tuple[1];
void first; void second;
`);
    expect(errors).toEqual([]);
  });

  it('E17-P12 a readonly tuple, a dynamic array, an empty list and a union keep their value types', () => {
    const { errors } = check(`
const frozen = [Mail, clock] as const;
const fromFrozen = box.resolveMany(frozen);
type _Frozen = Expect<Equal<typeof fromFrozen, [Mail, Clock]>>;
const dynamic: Array<typeof Mail> = [Mail];
const fromDynamic = box.resolveMany(dynamic);
type _Dynamic = Expect<Equal<typeof fromDynamic, Mail[]>>;
const readonlyDynamic: ReadonlyArray<Token<Clock>> = [clock];
const fromReadonly = box.resolveMany(readonlyDynamic);
type _Readonly = Expect<Equal<typeof fromReadonly, Clock[]>>;
const none = box.resolveMany([]);
type _None = Expect<Equal<typeof none, []>>;
const either = flag ? Mail : clock;
const fromUnion = box.resolveMany([either]);
type _Union = Expect<Equal<typeof fromUnion, [Mail | Clock]>>;
const fromMixed = box.resolveMany([Mail, either]);
type _Mixed = Expect<Equal<typeof fromMixed, [Mail, Mail | Clock]>>;
`);
    expect(errors).toEqual([]);
  });

  it('E17-P12 a scope and the minimal profile have the method, with the same types', () => {
    const { errors } = check(`
const scope = box.createScope();
const fromScope = scope.resolveMany([clock, Mail]);
type _Scope = Expect<Equal<typeof fromScope, [Clock, Mail]>>;
const fromCore = core.resolveMany([Mail, Sms]);
type _Core = Expect<Equal<typeof fromCore, [Mail, Sms]>>;
const coreScope = core.createScope().resolveMany([retries]);
type _CoreScope = Expect<Equal<typeof coreScope, [number]>>;
const built = defineBuilderConfig({ name: 'E17', runtime: { profile: 'minimal' }, injections: [{ token: Mail }] });
const fromBuilt = built.resolveMany([Mail]);
type _Built = Expect<Equal<typeof fromBuilt, [Mail]>>;
`);
    expect(errors).toEqual([]);
  });

  it('E17-P12 the context of a factory infers the tuple of its tokens', () => {
    const { errors } = check(`
const [mail, now] = context.resolveMany([Mail, clock]);
type _Mail = Expect<Equal<typeof mail, Mail>>;
type _Now = Expect<Equal<typeof now, Clock>>;
const built = defineBuilderConfig({
  name: 'E17Factory',
  injections: [
    { token: Mail },
    { token: clock, useFactory: true, dependencies: [Mail], provider: (ctx) => {
      const [sender] = ctx.resolveMany([Mail]);
      type _Sender = Expect<Equal<typeof sender, Mail>>;
      return { now: () => sender.send().length };
    } },
  ],
});
void built;
`);
    expect(errors).toEqual([]);
  });

  it('E17-P12 a value that is not a token is refused, and a tuple of the wrong value type is refused', () => {
    const { errors } = check(`
box.resolveMany([42]);
const wrong: [number, Clock] = box.resolveMany([Mail, clock]);
void wrong;
core.resolveMany(['text']);
context.resolveMany([{}]);
`);
    expect(errors.map((line) => /error (TS\d+)/.exec(line)?.[1])).toEqual(['TS2322', 'TS2322', 'TS2322', 'TS2322']);
  });

  it('E17-P13 1000 tokens give a tuple of 1000 values, with no TS2589', () => {
    // Each class has its own shape (a distinct literal id): two classes are never interchangeable, so a swapped position is an error.
    const classes = Array.from({ length: 1000 }, (_, index) => `class T${index} { readonly id = 'T${index}'; }`).join('\n');
    const list = Array.from({ length: 1000 }, (_, index) => `T${index}`).join(', ');
    const { errors, output } = check(`
${classes}
const r = box.resolveMany([${list}]);
const n: 1000 = r.length;
const last: T999 = r[999];
const middle: T500 = r[500];
void n; void last; void middle;
`);
    expect(output).not.toContain('TS2589');
    expect(errors).toEqual([]);
  }, 120_000);
});
