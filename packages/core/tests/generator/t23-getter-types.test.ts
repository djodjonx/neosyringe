import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { checkStrict, formatDiagnostic, unsafeTypesMessage, type StrictDiagnostic } from '../helpers/t23-program';
import { named, type ProductEmitter } from '../helpers/t00-contract';

/**
 * T23 B5, slice S3b (P8). A getter that builds a service has the type of the provider, so the argument
 * it hands to a constructor is checked by the compiler. The checks run on rendered output in a real strict
 * Program (lib es2022, strict, noImplicitAny, strictFunctionTypes) with a consumer source.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

const CONSUMER = [
  "import { box } from './box.out.ts';",
  'export async function consume(): Promise<void> {',
  '  await box.initialize();',
  '  await box.destroy();',
  '}',
  '',
].join('\n');

interface Corpus {
  /** Files of the user's program. `main.ts` holds the container `box`. */
  files: Readonly<Record<string, string>>;
}

interface Rendered {
  code: string;
  diagnostics: StrictDiagnostic[];
  check: (code: string) => StrictDiagnostic[];
}

/** Emits `box` of `main.ts` with the optimized emitter in its own output file, then checks it. */
function emitOptimized(corpus: Corpus, options: { emitter?: ProductEmitter } = {}): Rendered {
  warmLibCache();
  const dir = '/virtual/t23/getters';
  const userPath = `${dir}/main.ts`;
  const sources = new Map(Object.entries(corpus.files).map(([name, text]) => [`${dir}/${name}`, text]));
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => name === dir || (directoryExists?.(name) ?? false);
  host.readFile = (name) => sources.get(name) ?? ts.sys.readFile(name);
  const program = createFastProgram([...sources.keys()], compilerOptions, host);
  const graphs = new Analyzer(program).extractAll();
  const code = new Generator(named(graphs, 'box'), false, dirname(userPath), true, false, options.emitter ?? 'optimized').generate();
  const extraFiles = Object.entries(corpus.files)
    .filter(([name]) => name !== 'main.ts')
    .map(([file, text]) => ({ file, text }));
  const check = (output: string): StrictDiagnostic[] => checkStrict({
    dir,
    userSource: { file: 'main.ts', text: corpus.files['main.ts'] ?? '' },
    outputs: [{ file: 'box.out.ts', code: output }],
    consumer: { file: 'consumer.ts', code: CONSUMER },
    extraFiles,
  });
  return { code, diagnostics: check(code), check };
}

const SHAPES = `
  export interface T23Made { n: number }
  export interface T23Seed { n: number }
`;

/** Class providers, a factory and a useValue under exported interfaces, and an interface the output cannot name. */
const ACCESSORS: Corpus = {
  files: {
    'shapes.ts': SHAPES,
    'main.ts': `
      ${STUB}
      import type { T23Made, T23Seed } from './shapes';
      export class T23Leaf { n = 1; }
      export class T23Svc { constructor(readonly leaf: T23Leaf) {} }
      interface T23Hidden { n: number }
      const made = useInterface<T23Made>();
      const seed = useInterface<T23Seed>();
      const hidden = useInterface<T23Hidden>();
      export class T23Needs { constructor(readonly svc: T23Svc, readonly made: T23Made, readonly seed: T23Seed) {} }
      export class T23NeedsHidden { constructor(readonly hidden: T23Hidden, readonly leaf: T23Leaf) {} }
      export const box = defineBuilderConfig({
        name: 'T23Accessors',
        injections: [
          { token: T23Leaf },
          { token: T23Svc },
          { token: made, useFactory: true, dependencies: [], provider: () => ({ n: 4 }) },
          { token: seed, useValue: { n: 3 } },
          { token: hidden, useFactory: true, dependencies: [], provider: () => ({ n: 5 }) },
          { token: T23Needs },
          { token: T23NeedsHidden },
        ],
      });
    `,
  },
};

/** A class token registered with a provider of another type: the analyzer lets a class token through. */
function wrongProvider(profile: 'full' | 'minimal'): Corpus {
  return {
    files: {
      'main.ts': `
        ${STUB}
        export class T23Leaf { n = 1; }
        export class T23Stranger { label = 'stranger'; }
        export class T23Wants { constructor(readonly leaf: T23Leaf) {} }
        export const box = defineBuilderConfig({
          name: 'T23Wrong',
          runtime: { profile: '${profile}' },
          injections: [
            { token: T23Leaf, provider: T23Stranger },
            { token: T23Wants },
          ],
        });
      `,
    },
  };
}

/** A generic class has no single instance type to name: `InstanceType<typeof Box>` is `Box<unknown>`. */
const GENERIC: Corpus = {
  files: {
    'main.ts': `
      ${STUB}
      export class T23Leaf { n = 1; }
      export class T23Box<T = string> { value?: T; constructor(readonly leaf: T23Leaf) {} }
      export const box = defineBuilderConfig({
        name: 'T23Generic',
        injections: [
          { token: T23Leaf },
          { token: T23Box },
        ],
      });
    `,
  },
};

/**
 * A class token whose constructor is not public (the usual singleton) with a factory: nothing calls `new` on it,
 * so the registration is valid, and `InstanceType<typeof C>` would be a TS2344 on it. An abstract token too.
 */
const PRIVATE_CTOR: Corpus = {
  files: {
    'main.ts': `
      ${STUB}
      export class T23Clock { private constructor(readonly now: number) {} static make(): T23Clock { return new T23Clock(1); } }
      export class T23Guard { protected constructor() {} }
      export abstract class T23Port { abstract ping(): string; }
      export class T23Uses { constructor(readonly clock: T23Clock, readonly guard: T23Guard, readonly port: T23Port) {} }
      export const box = defineBuilderConfig({
        name: 'T23Private',
        injections: [
          { token: T23Clock, useFactory: true, dependencies: [], provider: () => ({ now: 2 }) },
          { token: T23Guard, useFactory: true, dependencies: [], provider: () => ({}) },
          { token: T23Port, useFactory: true, dependencies: [], provider: () => ({ ping: () => 'pong' }) },
          { token: T23Uses },
        ],
      });
    `,
  },
};

/** A generic class token has no single instance type to name: its bare name is not a type (TS2314). */
const GENERIC_TOKEN: Corpus = {
  files: {
    'main.ts': `
      ${STUB}
      export class T23Cell<T> { value?: T; }
      export const box = defineBuilderConfig({
        name: 'T23GenericToken',
        injections: [
          { token: T23Cell, useFactory: true, dependencies: [], provider: () => ({}) },
        ],
      });
    `,
  },
};

/**
 * A token that is a value alias of a class (`const Alias = Clock`) is accepted by the analyzer, but `Alias` is a value:
 * it is not a type. Its getters must not name it as one.
 */
const ALIAS_TOKEN: Corpus = {
  files: {
    'main.ts': `
      ${STUB}
      export class T23Clock { constructor(readonly now: number) {} }
      export const T23Alias = T23Clock;
      export class T23Uses { constructor(readonly clock: T23Clock) {} }
      export const box = defineBuilderConfig({
        name: 'T23AliasToken',
        injections: [
          { token: T23Alias, useFactory: true, dependencies: [], provider: () => ({ now: 2 }) },
          { token: T23Uses },
        ],
      });
    `,
  },
};

/** The same alias as a class provider. */
const ALIAS_PROVIDER: Corpus = {
  files: {
    'main.ts': `
      ${STUB}
      export class T23Clock { constructor(readonly now: number = 1) {} }
      export const T23Alias = T23Clock;
      export class T23Uses { constructor(readonly clock: T23Clock) {} }
      export const box = defineBuilderConfig({
        name: 'T23AliasProvider',
        injections: [
          { token: T23Alias },
          { token: T23Uses },
        ],
      });
    `,
  },
};

/**
 * A hoisted useValue is read under its declared type. Without that type on the constant, its literals widen
 * (`{ kind: 'a' }` is `{ kind: string }`) and the reader's parameter refuses it.
 */
const LITERAL: Corpus = {
  files: {
    'shapes.ts': "export interface T23Kind { kind: 'a' | 'b' }\n",
    'main.ts': `
      ${STUB}
      import type { T23Kind } from './shapes';
      interface T23Mode { mode: 'dev' | 'prod' }
      const kind = useInterface<T23Kind>();
      const mode = useInterface<T23Mode>();
      export class T23Reads { constructor(readonly kind: T23Kind, readonly mode: T23Mode) {} }
      export const box = defineBuilderConfig({
        name: 'T23Literal',
        injections: [
          { token: kind, useValue: { kind: 'a' } },
          { token: mode, useValue: { mode: 'dev' } },
          { token: T23Reads },
        ],
      });
    `,
  },
};

function methodSignature(code: string, accessor: RegExp): string {
  const found = code.match(accessor);
  if (!found) throw new Error(`no method matches ${accessor}`);
  return found[0];
}

/** The method of `code` whose signature matches, up to its closing brace (the generated class indents its methods by two). */
function methodBody(code: string, accessor: RegExp): string {
  const signature = methodSignature(code, accessor);
  const start = code.indexOf(signature);
  const end = code.indexOf('\n  }', start);
  if (end === -1) throw new Error(`method ${signature} has no end`);
  return code.slice(start, end);
}

describe('T23-P8 getters have the type of their provider', () => {
  it('T23-P8 a class provider names its instance type on the creator, the direct accessor and the read accessor', () => {
    const { code } = emitOptimized(ACCESSORS);
    expect(methodSignature(code, /private create_T23Svc\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Svc> {');
    expect(methodSignature(code, /private _direct_T23Svc\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Svc> {');
    expect(methodSignature(code, /private _get_T23Svc\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Svc> {');
  });

  it('T23-P8 a factory under an exported interface names that interface, a hoisted value too', () => {
    const { code } = emitOptimized(ACCESSORS);
    expect(methodSignature(code, /private _get_T23Made\w*\(\): [^{]+\{/)).toMatch(/\(\): __neo_Type_T23Made \{/);
    // A hoisted value answers the type it is declared under, on the creator and on the accessors.
    expect(methodSignature(code, /private _get_T23Seed\w*\(\): [^{]+\{/)).toMatch(/\(\): __neo_Type_T23Seed \{/);
    expect(methodSignature(code, /private create_T23Seed\w*\(\): [^{]+\{/)).toMatch(/\(\): __neo_Type_T23Seed \{/);
    // The factory creator hands out what the user's factory returned.
    expect(methodSignature(code, /private create_T23Made\w*\(\): [^{]+\{/)).toContain('(): unknown {');
  });

  it('T23-P8 the types are imported with `import type`, so the output gains no runtime dependency', () => {
    const { code, diagnostics } = emitOptimized(ACCESSORS);
    expect(code).toContain("import type { T23Made as __neo_Type_T23Made } from './shapes.ts';");
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    const emitted = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    }).outputText;
    const required = [...emitted.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(required).toEqual(['./main.ts']);
  });

  it('T23-P8 a factory accessor narrows its cache read and its creator result to the declared type', () => {
    const { code, diagnostics } = emitOptimized(ACCESSORS);
    const accessor = methodBody(code, /private _direct_T23Made\w*\(\): [^{]+\{/);
    expect(accessor).toMatch(/if \(this\.instances\.has\([^)]*\)\) return this\.instances\.get\([^)]*\) as __neo_Type_T23Made;/);
    expect(accessor).toMatch(/const instance = this\.create_T23Made\w*\(\) as __neo_Type_T23Made;/);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('T23-P8 a constructor argument read from a typed accessor carries no assertion', () => {
    const { code } = emitOptimized(ACCESSORS);
    const construction = code.match(/return new Import_0\.T23Svc\(.*\);/)?.[0] ?? '';
    expect(construction).toMatch(/^return new Import_0\.T23Svc\(this\._get_T23Leaf\w*\(\)\);$/);
    expect(construction).not.toContain(' as ');
  });

  it('T23-P8 a provider type the output cannot name keeps `unknown` and narrows at the read, only there', () => {
    const { code, diagnostics } = emitOptimized(ACCESSORS);
    expect(methodSignature(code, /private _get_T23Hidden\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    const narrowed = code.match(/this\._get_T23Hidden\w*\(\) as [^,)]+/g) ?? [];
    expect(narrowed).toEqual([expect.stringMatching(/ as ConstructorParameters<typeof Import_0\.T23NeedsHidden>\[0\]$/)]);
    // The typed neighbour of the same constructor is read without it.
    expect(code).toMatch(/new Import_0\.T23NeedsHidden\(this\._get_T23Hidden\w*\(\) as [^,]+, this\._get_T23Leaf\w*\(\)\)/);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it.each(['full', 'minimal'] as const)(
    'T23-P8 a class token registered with a provider of another type is reported (%s profile)',
    (profile) => {
      const { diagnostics } = emitOptimized(wrongProvider(profile));
      expect(diagnostics.map((item) => `${item.file} TS${item.code}`)).toEqual(['box.out.ts TS2345']);
      expect(diagnostics[0]?.message).toContain('T23Stranger');
      expect(diagnostics[0]?.message).toContain('T23Leaf');
    },
  );

  it('T23-P8 an accessor erased to unknown is reported where its value is read', () => {
    const rendered = emitOptimized(ACCESSORS);
    const signature = methodSignature(rendered.code, /private _get_T23Leaf\w*\(\): [^{]+\{/);
    const erased = rendered.code.replace(signature, signature.replace(/\(\): [^{]+\{/, '(): unknown {'));
    expect(erased).not.toBe(rendered.code);
    const codes = rendered.check(erased).map((item) => `${item.file} TS${item.code}`);
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)]).toEqual(['box.out.ts TS2345']);
  });

  it('T23-P8 a generic class provider has `unknown` getters: its instance type is not one type', () => {
    const { code, diagnostics } = emitOptimized(GENERIC);
    expect(methodSignature(code, /private create_T23Box\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    expect(methodSignature(code, /private _direct_T23Box\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    expect(methodSignature(code, /private _get_T23Box\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    // The non-generic neighbour keeps its type.
    expect(methodSignature(code, /private _get_T23Leaf\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Leaf> {');
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('T23-P8 a factory under a class token with a private, protected or abstract constructor has no diagnostic', () => {
    const { diagnostics } = emitOptimized(PRIVATE_CTOR);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('T23-P8 that class token is named by its own name, which needs no public constructor', () => {
    const { code } = emitOptimized(PRIVATE_CTOR);
    for (const name of ['T23Clock', 'T23Guard', 'T23Port']) {
      expect(methodSignature(code, new RegExp(`private _direct_${name}\\w*\\(\\): [^{]+\\{`))).toContain(`(): Import_0.${name} {`);
      expect(methodSignature(code, new RegExp(`private _get_${name}\\w*\\(\\): [^{]+\\{`))).toContain(`(): Import_0.${name} {`);
    }
    expect(code).not.toContain('InstanceType<typeof Import_0.T23Clock>');
  });

  it('T23-P8 a factory under a generic class token has an `unknown` accessor and no diagnostic', () => {
    const { code, diagnostics } = emitOptimized(GENERIC_TOKEN);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(methodSignature(code, /private _get_T23Cell\w*\(\): [^{]+\{/)).toContain('(): unknown {');
  });

  it('T23-P8 a factory under a token that is a value alias of a class has no diagnostic and `unknown` accessors', () => {
    const { code, diagnostics } = emitOptimized(ALIAS_TOKEN);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(methodSignature(code, /private _direct_T23Clock\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    expect(methodSignature(code, /private _get_T23Clock\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    // The reader's constructor argument is narrowed once, to the class it asks for.
    expect(code).toMatch(/new Import_0\.T23Uses\(this\._get_T23Clock\w*\(\) as ConstructorParameters<typeof Import_0\.T23Uses>\[0\]\)/);
  });

  it('T23-P8 a class provider registered under a value alias of a class has no diagnostic and keeps its instance type', () => {
    const { code, diagnostics } = emitOptimized(ALIAS_PROVIDER);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(methodSignature(code, /private _get_T23Clock\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Alias> {');
  });

  it('T23-P8 a hoisted useValue is annotated with its declared type, so its literals do not widen', () => {
    const { code, diagnostics } = emitOptimized(LITERAL);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(code).toMatch(/const __neoCapture_\w+: __neo_Type_T23Kind = \{ kind: 'a' \};/);
    expect(methodSignature(code, /private _get_T23Kind\w*\(\): [^{]+\{/)).toContain('(): __neo_Type_T23Kind {');
  });

  it('T23-P8 the reference emitter annotates the hoisted useValue too, with the type it imports', () => {
    const { code, diagnostics } = emitOptimized(LITERAL, { emitter: 'reference' });
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(code).toMatch(/const __neoCapture_\w+: __neo_Type_T23Kind = \{ kind: 'a' \};/);
    expect(code).toContain("import type { T23Kind as __neo_Type_T23Kind } from './shapes.ts';");
  });

  it('T23-P8 a hoisted useValue under a type the output cannot name keeps `unknown` and narrows at the read', () => {
    const { code, diagnostics } = emitOptimized(LITERAL);
    expect(methodSignature(code, /private _get_T23Mode\w*\(\): [^{]+\{/)).toContain('(): unknown {');
    expect(code).toMatch(/const __neoCapture_\w+ = \{ mode: 'dev' \};/);
    expect(code).toMatch(/this\._get_T23Mode\w*\(\) as ConstructorParameters<typeof Import_0\.T23Reads>\[1\]/);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('T23-P8 the typed output has no unsafe type', () => {
    const { code } = emitOptimized(ACCESSORS);
    expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
  });

  it('T23-P8 the reference emitter names the same creator types and still type-checks', () => {
    const { code, diagnostics } = emitOptimized(ACCESSORS, { emitter: 'reference' });
    expect(methodSignature(code, /private create_T23Svc\w*\(\): [^{]+\{/)).toContain('(): InstanceType<typeof Import_0.T23Svc> {');
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });
});
