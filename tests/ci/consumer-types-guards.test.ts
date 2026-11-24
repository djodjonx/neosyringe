import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const scale = path.join(root, 'scripts/ci/consumer-types-scale.mjs');
const entry = path.join(root, 'packages/neosyringe/src/index.ts');

const TSCONFIG = (dirTypes: string) => `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true,
    "types": [],
    "baseUrl": ".",
    "paths": { "@djodjonx/neosyringe": [${JSON.stringify(dirTypes)}] }
  },
  "files": ["consumer.ts"]
}
`;

function runProject(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-guard-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG(entry));
    writeFileSync(path.join(dir, 'consumer.ts'), source);
    return spawnSync(process.execPath, [harness, dir], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function diagnostics(output: string): { line: number; column: number; code: string }[] {
  return [...output.matchAll(/\((\d+),(\d+)\): error TS(\d+)/g)].map((hit) => ({
    line: Number(hit[1]),
    column: Number(hit[2]),
    code: hit[3] ?? '',
  }));
}

/** 1-based line of the first source line that contains `marker`. */
function lineOf(source: string, marker: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(marker));
  if (index < 0) throw new Error(`no line with ${marker}`);
  return index + 1;
}

describe('consumer-types guards', () => {
  it('P3 bad factory at start middle and end', () => {
    for (const where of ['start', 'middle', 'end'] as const) {
      const run = spawnSync(process.execPath, [scale, '1000', '--bad', where], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
      expect(output, where).not.toContain('TS2589');
      expect(run.status, output).toBe(0);
      expect(output, where).toMatch(/code=TS\d+/);
    }
  }, 180_000);

  it('P5 required-args class is a token and a Constructor call with an arg is refused', () => {
    const run = runProject(`
import { useProperty, type Constructor, type Token } from '@djodjonx/neosyringe';
class Needs { constructor(readonly label: string) {} }
const token: Token<Needs> = Needs;
const ctor: Constructor<Needs> = Needs;
const property = useProperty<string>(Needs, 'label');
// @ts-expect-error
new ctor('x');
void token;
void property;
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('P6 a default Token does not yield an unsafe value', () => {
    const run = runProject(`
import { declareContainerTokens, type Token } from '@djodjonx/neosyringe';
type IsUnsafe<T> = 0 extends (1 & T) ? true : false;
type Value<T> = T extends Token<infer V> ? V : never;
type Assert<T extends true> = T;
type _Safe = Assert<IsUnsafe<Value<Token>> extends false ? true : false>;
class Listed { n = 1; }
const legacy: { nope: boolean } = { nope: false };
const tokens = declareContainerTokens<{ Listed: Listed }>(legacy);
const value: Listed = tokens.Listed;
void value;
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('P7 FactoryContext rejects an invented method', () => {
    const run = runProject(`
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
interface Port { n: number }
const port = useInterface<Port>();
export const container = defineBuilderConfig({
  injections: [{
    token: port,
    useFactory: true,
    dependencies: [],
    provider: (ctx) => {
      const one = ctx.resolve(port);
      const all = ctx.resolveAll(port);
      // @ts-expect-error
      ctx.nope();
      return { n: one.n + all.length };
    },
  }],
});
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(output).not.toContain('TS2339');
    expect(run.status, output).toBe(0);
  });

  it('P8 OverrideGuard unions', () => {
    const run = runProject(`
import { useInterface, useProperty, type OverrideEntry, type OverrideGuard } from '@djodjonx/neosyringe';
class Service { constructor(readonly label: string) {} }
interface Port { requestId: string }
const request = useInterface<Port>();
const count = useProperty<number>(Service, 'label');
type GoodOverride = readonly [typeof count, () => number] | readonly [typeof request, () => Port];
type BadOverride = readonly [typeof count, () => Port] | readonly [typeof request, () => number];
declare function takeOverride<const E extends readonly OverrideEntry[]>(entries: E & OverrideGuard<E>): void;
declare const goodOverride: readonly GoodOverride[];
declare const badOverride: readonly BadOverride[];
takeOverride(goodOverride);
// @ts-expect-error
takeOverride(badOverride);
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('P9 InputGuard unions', () => {
    const run = runProject(`
import { useInterface, useProperty, type InputEntry, type InputGuard } from '@djodjonx/neosyringe';
class Service { constructor(readonly label: string) {} }
interface Port { requestId: string }
const request = useInterface<Port>();
const count = useProperty<number>(Service, 'label');
type Tokens = readonly [typeof count, typeof request];
type GoodInput = { readonly token: typeof count; readonly useValue: number }
  | { readonly token: typeof request; readonly useValue: Port };
type BadInput = { readonly token: typeof count; readonly useValue: Port }
  | { readonly token: typeof request; readonly useValue: number };
declare function takeInput<const E extends readonly InputEntry[]>(entries: E & InputGuard<Tokens, E>): void;
declare const goodInput: readonly GoodInput[];
declare const badInput: readonly BadInput[];
takeInput(goodInput);
// @ts-expect-error
takeInput(badInput);
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('W3 InputGuard rejects a missing input and an extra input', () => {
    const run = runProject(`
import { useInterface, type InputEntry, type InputGuard, type InputToken } from '@djodjonx/neosyringe';
interface Port { requestId: string }
interface Extra { n: number }
const request = useInterface<Port>();
const extra = useInterface<Extra>();
type Declared = readonly [typeof request];
type Exact = readonly [{ readonly token: typeof request; readonly useValue: Port }];
type Missing = readonly [];
type WithExtra = readonly [
  { readonly token: typeof request; readonly useValue: Port },
  { readonly token: typeof extra; readonly useValue: Extra },
];
declare function take<I extends readonly InputToken[], const E extends readonly InputEntry[]>(
  values: E & InputGuard<I, E>,
): void;
declare const exact: Exact;
declare const missing: Missing;
declare const withExtra: WithExtra;
take<Declared, Exact>(exact);
// @ts-expect-error
take<Declared, Missing>(missing);
// @ts-expect-error
take<Declared, WithExtra>(withExtra);
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('P10 ValuesOf is the exact tuple', () => {
    const run = runProject(`
import { type Token, type ValuesOf } from '@djodjonx/neosyringe';
class Service { n = 1; }
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _Values = Assert<Equal<ValuesOf<[Token<Service>, Token<number>]>, [Service, number]>>;
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('P11 invalid config is one diagnostic and still Container', () => {
    const source = `
import { defineBuilderConfig, type Container } from '@djodjonx/neosyringe';
class Service { value = 1; }
const container = defineBuilderConfig({
  injections: [{ token: Service, useFactory: true, dependencies: [], provider: () => 'bad' }],
});
const asContainer: Container = container;
asContainer.resolve(Service);
`;
    const lines = source.split('\n');
    const assignment = lines.findIndex((line) => line.includes('const asContainer')) + 1;
    const run = runProject(source);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const found = diagnostics(output);
    expect(found.map((item) => item.line), output).not.toContain(assignment);
    expect(found, output).toHaveLength(1);
  });

  const FACTORY_SHAPES = `
import { defineBuilderConfig, useInterface, type FactoryContext, type Injection } from '@djodjonx/neosyringe';
interface Port { n: number }
const port = useInterface<Port>();
class Svc { value = 1; }
type BadF = { token: typeof port; useFactory: true; dependencies: []; provider: (c: FactoryContext) => string };
type GoodF = { token: typeof port; useFactory: true; dependencies: []; provider: (c: FactoryContext) => Port };
`;

  it('W7 a widened array of a wrongly typed factory is refused', () => {
    const source = `${FACTORY_SHAPES}
declare const badArray: BadF[];
declare const badReadonly: readonly BadF[];
declare const badSpread: [...BadF[], { token: typeof Svc }];
declare const goodThenBad: [GoodF, ...BadF[]];
export const onArray = defineBuilderConfig({ injections: badArray });
export const onReadonly = defineBuilderConfig({ injections: badReadonly });
export const onSpread = defineBuilderConfig({ injections: badSpread });
export const onTail = defineBuilderConfig({ injections: goodThenBad });
`;
    const run = runProject(source);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const found = diagnostics(output);
    const wanted = ['onArray', 'onReadonly', 'onSpread', 'onTail'].map((name) => lineOf(source, `export const ${name}`));
    expect(found.map((item) => item.line), output).toEqual(wanted);
    expect(found.map((item) => item.code), output).toEqual(['2769', '2769', '2769', '2769']);
  });

  it('W8 a widened array of right factories is accepted, and the union limit is pinned', () => {
    const run = runProject(`${FACTORY_SHAPES}
declare const goodArray: GoodF[];
declare const annotated: Injection[];
export const onGood = defineBuilderConfig({ injections: goodArray });
export const onAnnotated = defineBuilderConfig({ injections: annotated });
// Known limit: a union element hides the wrong member, so these two stay accepted.
declare const unionArray: (BadF | GoodF)[];
declare const unionTuple: [BadF | GoodF];
export const onUnionArray = defineBuilderConfig({ injections: unionArray });
export const onUnionTuple = defineBuilderConfig({ injections: unionTuple });
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('W9 a tuple held in a variable is refused at the callee name', () => {
    const source = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
interface Port { n: number }
const port = useInterface<Port>();
const bad = { token: port, useFactory: true, dependencies: [], provider: () => 'x' } as const;
const tuple = [bad] as const;
export const held = defineBuilderConfig({ injections: tuple });
`;
    const run = runProject(source);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    const heldLine = lineOf(source, 'export const held');
    const callee = (source.split('\n')[heldLine - 1] ?? '').indexOf('defineBuilderConfig') + 1;
    expect(diagnostics(output), output).toEqual([{ line: heldLine, column: callee, code: '2769' }]);
  });

  const SCOPE_SHAPES = `
import { useInterface, type InputEntry, type InputGuard, type InputToken, type ScopeArguments } from '@djodjonx/neosyringe';
interface Port { requestId: string }
const request = useInterface<Port>();
declare function createScope<const I extends readonly InputToken[], const E extends readonly InputEntry[]>(
  ...args: ScopeArguments<I, E>
): void;
type Entry = { readonly token: typeof request; readonly useValue: Port };
declare const entry: Entry;
`;

  it('W10 ScopeArguments makes the values optional when no input is declared', () => {
    const run = runProject(`${SCOPE_SHAPES}
createScope<readonly [], readonly []>();
createScope<readonly [], readonly []>({ values: [] });
createScope<readonly [typeof request], readonly [Entry]>({ values: [entry] });
`);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.status, output).toBe(0);
  });

  it('W11 ScopeArguments requires the values when an input is declared', () => {
    const source = `${SCOPE_SHAPES}
createScope<readonly [typeof request], readonly [Entry]>();
`;
    const run = runProject(source);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(diagnostics(output), output).toEqual([
      { line: lineOf(source, 'createScope<readonly [typeof request]'), column: 1, code: '2554' },
    ]);
  });
});
