import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * E18 scope inputs, typed on the public surface. Each source is typechecked by the consumer-types harness against the
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
import {
  defineBuilderConfig,
  definePartialConfig,
  useInterface,
  useProperty,
  type BoundContainer,
  type Container,
  type CoreContainer,
  type ContainerTemplate,
  type InputToken,
} from '@djodjonx/neosyringe';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
interface Req { id: string }
interface Stranger { label: string }
class Svc { retries = 0; }
const req = useInterface<Req>();
const stranger = useInterface<Stranger>();
const retries = useProperty<number>(Svc, 'retries');
const requests = defineBuilderConfig({ name: 'Requests', scopeInputs: [req, retries], injections: [{ token: Svc }] });
const minimal = defineBuilderConfig({
  name: 'Minimal',
  runtime: { profile: 'minimal' },
  scopeInputs: [req],
  injections: [{ token: Svc }],
});
const values = [{ token: req, useValue: { id: '1' } }, { token: retries, useValue: 3 }] as const;
`;

interface Checked {
  status: number | null;
  output: string;
  errors: string[];
}

function check(source: string): Checked {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-e18-'));
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

describe('E18 scope inputs types', () => {
  it('E18-P14 the values are accepted in any order, the scope has the API of its profile, and no input means no change', () => {
    const source = `
const forward = requests.createScope({ values: [{ token: req, useValue: { id: '1' } }, { token: retries, useValue: 3 }] });
const reversed = requests.createScope({ values: [{ token: retries, useValue: 3 }, { token: req, useValue: { id: '1' } }] });
const byVariable = requests.createScope({ values });
const user: Req = forward.resolve(req);
const svc: Svc = reversed.resolve(Svc);
const many = byVariable.resolveMany([req, Svc]);
type _Many = Expect<Equal<typeof many, [Req, Svc]>>;
const ready: Promise<void> = forward.initialize();
const overridden: Promise<void> = forward.override(Svc, () => new Svc());
const nested = forward.createScope({ values });
const gone: Promise<void> = requests.destroy();
const minimalScope = minimal.createScope({ values: [{ token: req, useValue: { id: '2' } }] });
const resolved: Req = minimalScope.resolve(req);
const asTemplate: ContainerTemplate<readonly [typeof req, typeof retries], 'full'> = requests;
const asBound: BoundContainer<readonly [typeof req, typeof retries], 'full'> = forward;
const plain = defineBuilderConfig({ name: 'Plain', injections: [{ token: Svc }] });
type _Plain = Expect<Equal<typeof plain, Container>>;
const child: Container = plain.createScope();
const none = defineBuilderConfig({ name: 'None', scopeInputs: [], injections: [{ token: Svc }] });
type _None = Expect<Equal<typeof none, Container>>;
const plainMinimal = defineBuilderConfig({ name: 'PlainMin', runtime: { profile: 'minimal' }, injections: [{ token: Svc }] });
type _PlainMinimal = Expect<Equal<typeof plainMinimal, CoreContainer>>;
`;
    const { errors } = check(source);
    expect(errors).toEqual([]);
  });

  it('E18-P14 a missing, an extra and a wrong-type value are refused', () => {
    const source = `
requests.createScope({ values: [{ token: req, useValue: { id: '1' } }] });
requests.createScope({ values: [...values, { token: stranger, useValue: { label: '2' } }] });
requests.createScope({ values: [{ token: req, useValue: 42 }, { token: retries, useValue: 3 }] });
requests.createScope({ values: [{ token: req, useValue: { id: '1' } }, { token: retries, useValue: 'three' }] });
requests.createScope();
`;
    const { errors } = check(source);
    expect(where(errors, source)).toEqual([
      "TS2322 requests.createScope({ values: [{ token: req, useValue: { id: '1' } }] });",
      "TS2322 requests.createScope({ values: [...values, { token: stranger, useValue: { label: '2' } }] });",
      'TS2322 requests.createScope({ values: [{ token: req, useValue: 42 }, { token: retries, useValue: 3 }] });',
      "TS2322 requests.createScope({ values: [{ token: req, useValue: { id: '1' } }, { token: retries, useValue: 'three' }] });",
      'TS2554 requests.createScope();',
    ]);
  });

  it('E18-P14 the template has createScope and destroy only, and a scope asks for its values again', () => {
    const source = `
requests.resolve(req);
requests.resolveAll(req);
requests.initialize();
requests.override(Svc, () => new Svc());
const scope = requests.createScope({ values });
scope.createScope();
minimal.createScope({ values: [{ token: req, useValue: { id: '2' } }] }).override(Svc, () => new Svc());
`;
    const { errors } = check(source);
    expect(where(errors, source)).toEqual([
      'TS2339 requests.resolve(req);',
      'TS2339 requests.resolveAll(req);',
      'TS2339 requests.initialize();',
      'TS2339 requests.override(Svc, () => new Svc());',
      'TS2554 scope.createScope();',
      "TS2339 minimal.createScope({ values: [{ token: req, useValue: { id: '2' } }] }).override(Svc, () => new Svc());",
    ]);
  });

  it('E18-P14 a union of incoherent pairs is refused in a widened readonly array, a union of coherent pairs is accepted', () => {
    const source = `
declare const mixed: ReadonlyArray<{ readonly token: typeof req; readonly useValue: Req } | { readonly token: typeof retries; readonly useValue: Req }>;
requests.createScope({ values: mixed });
declare const coherent: ReadonlyArray<{ readonly token: typeof req; readonly useValue: Req } | { readonly token: typeof retries; readonly useValue: number }>;
requests.createScope({ values: coherent });
`;
    const { errors } = check(source);
    expect(where(errors, source)).toEqual(['TS2322 requests.createScope({ values: mixed });']);
  });

  it('E18-P14 inputs the builder does not state as a literal, a class token and a partial with inputs are refused', () => {
    const source = `
declare const list: readonly InputToken[];
defineBuilderConfig({ name: 'Widened', scopeInputs: list, injections: [{ token: Svc }] });
declare const config: { name: string; scopeInputs?: readonly [typeof req] };
defineBuilderConfig(config);
defineBuilderConfig({ name: 'Class', scopeInputs: [Svc], injections: [{ token: Svc }] });
definePartialConfig({ scopeInputs: [req], injections: [{ token: Svc }] });
defineBuilderConfig({ name: 'Child', useContainer: requests, injections: [{ token: Svc }] });
defineBuilderConfig({ name: 'Child', useContainer: requests.createScope({ values }), injections: [{ token: Svc }] });
`;
    const { errors } = check(source);
    expect(where(errors, source)).toEqual([
      "TS2769 defineBuilderConfig({ name: 'Widened', scopeInputs: list, injections: [{ token: Svc }] });",
      'TS2769 defineBuilderConfig(config);',
      "TS2769 defineBuilderConfig({ name: 'Class', scopeInputs: [Svc], injections: [{ token: Svc }] });",
      'TS2353 definePartialConfig({ scopeInputs: [req], injections: [{ token: Svc }] });',
      "TS2769 defineBuilderConfig({ name: 'Child', useContainer: requests, injections: [{ token: Svc }] });",
      "TS2769 defineBuilderConfig({ name: 'Child', useContainer: requests.createScope({ values }), injections: [{ token: Svc }] });",
    ]);
  });
});
