import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { assertNoUnsafeTypes } from '../../../../scripts/ci/lib/no-unsafe-types.mjs';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { cacheLibHost } from '../fastProgram';
import {
  CELLS,
  named,
  programOf,
  sourceFor,
  type ContractCell,
  type ProductEmitter,
} from './t00-contract';

/**
 * Real strict Program over emitted output, topic 23 B5.
 * `createFastProgram` forces `lib.es5` and `types: []`, so it cannot see `AggregateError`,
 * `Promise.allSettled` or `Error.cause`. Here the lib is a real es2022 lib (parsed once, cached),
 * and the options are the strict set a consumer turns on: strict, noImplicitAny, strictFunctionTypes.
 */
const STRICT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'],
  types: [],
  strict: true,
  noImplicitAny: true,
  strictFunctionTypes: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
};

/** Ambient declaration of `process`: the emitted debug getters read `process.env`, and `types` is empty. */
const PROCESS_DECLARATION = 'declare const process: { readonly env: Readonly<Record<string, string | undefined>> } | undefined;\n';

export interface StrictDiagnostic {
  /** Virtual file the diagnostic belongs to (`box.out.ts`, `consumer.ts`, ...). */
  file: string;
  code: number;
  line: number;
  column: number;
  message: string;
}

/** One emitted module handed to {@link checkStrict}. */
export interface EmittedModule {
  /** Virtual file name, unique inside the program. */
  file: string;
  code: string;
}

export interface StrictInput {
  /** Directory of every virtual file. */
  dir: string;
  /** The user's own source file: it is part of the program, its diagnostics are not reported. */
  userSource: { file: string; text: string };
  /** Emitted modules, checked. */
  outputs: readonly EmittedModule[];
  /** Consumer source, checked. */
  consumer: EmittedModule;
  /** Extra ambient declarations (e.g. the `parent` identifier an inlined container reads). */
  ambient?: string;
  /** Other source files of the program (the user's own modules). They are inputs, never subjects. */
  extraFiles?: readonly { file: string; text: string }[];
  /** Lib files of the program (`lib.es2021.d.ts`). Absent: the es2022 lib of {@link STRICT_OPTIONS}. */
  lib?: readonly string[];
}

function flatten(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, '\n');
}

/**
 * Type-checks `outputs` and `consumer` in one strict Program. Only their diagnostics come back:
 * the user's source and the ambient file are inputs, not subjects.
 */
export function checkStrict(input: StrictInput): StrictDiagnostic[] {
  const files = new Map<string, string>();
  const at = (name: string): string => join(input.dir, name).replace(/\\/g, '/');
  files.set(at(input.userSource.file), input.userSource.text);
  for (const extra of input.extraFiles ?? []) files.set(at(extra.file), extra.text);
  for (const output of input.outputs) files.set(at(output.file), output.code);
  files.set(at(input.consumer.file), input.consumer.code);
  const ambientName = at('ambient.d.ts');
  files.set(ambientName, `${PROCESS_DECLARATION}${input.ambient ?? ''}`);

  const options: ts.CompilerOptions = input.lib === undefined ? STRICT_OPTIONS : { ...STRICT_OPTIONS, lib: [...input.lib] };
  const host = cacheLibHost(ts.createCompilerHost(options));
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = files.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => files.has(name) || exists(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => name === input.dir || (directoryExists?.(name) ?? false);
  host.readFile = (name) => files.get(name) ?? ts.sys.readFile(name);

  const program = ts.createProgram([...files.keys()], options, host);
  const subjects = [...input.outputs, input.consumer];
  const result: StrictDiagnostic[] = [];
  for (const subject of subjects) {
    const sourceFile = program.getSourceFile(at(subject.file));
    if (!sourceFile) throw new Error(`file missing from the program: ${subject.file}`);
    const found = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];
    for (const diagnostic of found) {
      const start = diagnostic.start ?? 0;
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      result.push({
        file: subject.file,
        code: diagnostic.code,
        line: position.line + 1,
        column: position.character + 1,
        message: flatten(diagnostic.messageText),
      });
    }
  }
  return result;
}

/** `TS7006 box.out.ts:12:5 Parameter 'code' implicitly has an 'any' type.` */
export function formatDiagnostic(diagnostic: StrictDiagnostic): string {
  return `TS${diagnostic.code} ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`;
}

/** `assertNoUnsafeTypes` as a message: the empty string means the output is clean. */
export function unsafeTypesMessage(code: string, filename: string): string {
  try {
    assertNoUnsafeTypes(ts, code, filename);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

export const EMITTERS: readonly ProductEmitter[] = ['reference', 'optimized'];

/** One source to emit and check. `parent` cells also emit the parent container. */
export interface EmissionCase {
  name: string;
  profile: 'full' | 'minimal';
  source: string;
  /** Generator `testOverrides`: the emitted override() performs a real reconfigure. */
  testOverrides: boolean;
  parent: boolean;
  /** Ambient declarations of the user-scope names a factory body reads (the output is a separate file). */
  ambient?: string;
  /** Analyzer validation. `compatible` lets a factory without a dependencies list through (an opaque factory). */
  validation?: 'compatible';
}

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

/** Several tokens of one multi registration, classes that take constructor dependencies, sync and async. */
const MULTI_SOURCE = `
  ${STUB}
  interface T23Item { n: number }
  const item = useInterface<T23Item>();
  export class T23Leaf { n = 1; }
  export class T23Consumer { constructor(readonly leaf: T23Leaf) {} }
  export const box = defineBuilderConfig({
    name: 'T23Multi',
    injections: [
      { token: item, useFactory: true, dependencies: [], multi: true, provider: () => ({ n: 1 }) },
      { token: item, useFactory: true, dependencies: [], multi: true, lifecycle: 'transient', provider: () => ({ n: 2 }) },
      { token: item, useValue: { n: 3 }, multi: true },
      { token: T23Leaf },
      { token: T23Consumer },
    ],
  });
`;

const MULTI_ASYNC_SOURCE = MULTI_SOURCE.replace(
  "provider: () => ({ n: 1 })",
  'provider: async () => ({ n: 1 })',
);

/** Disposable singletons (sync and async), a transient, and a class that depends on both. */
const LIFECYCLE_SOURCE = `
  ${STUB}
  export class T23Db { dispose(): void {} }
  export class T23Queue { async dispose(): Promise<void> {} }
  export class T23Repo { constructor(readonly db: T23Db, readonly queue: T23Queue) {} dispose(): void {} }
  interface T23Made { n: number }
  const made = useInterface<T23Made>();
  export const box = defineBuilderConfig({
    name: 'T23Lifecycle',
    injections: [
      { token: T23Db },
      { token: T23Queue },
      { token: T23Repo },
      { token: made, useFactory: true, lifecycle: 'transient', dependencies: [T23Db], provider: () => ({ n: 4 }) },
    ],
  });
`;

const LIFECYCLE_ASYNC_SOURCE = LIFECYCLE_SOURCE.replace(
  "lifecycle: 'transient', dependencies: [T23Db], provider: () => ({ n: 4 })",
  'dependencies: [T23Db], provider: async () => ({ n: 4 })',
);

/**
 * Factory bodies written the way the public types let a user write them. Each hands a context result to a
 * parameter that has a type, so a context that answers `unknown` is refused (TS2345). The output is a
 * separate file: `T23Dep`, `T23Items` and `items` are user-scope names, declared in the ambient file.
 */
const CTX_AMBIENT = `
declare class T23Dep { n: number }
interface T23Items { n: number }
declare const items: unknown;
`;

const CTX_BODIES = `
      { token: T23Dep },
      { token: items, useValue: { n: 5 }, multi: true },
      // unannotated context
      { token: made, useFactory: true, dependencies: [T23Dep], provider: (ctx) => ((dep: T23Dep) => ({ n: dep.n }))(ctx.resolve(T23Dep)) },
      // context annotated with the public shape
      { token: annotated, useFactory: true, dependencies: [T23Dep], provider: (ctx: { resolve<T>(token: unknown): T; resolveAll<T>(token: unknown): T[] }) => ((dep: T23Dep) => ({ n: dep.n }))(ctx.resolve(T23Dep)) },
      // default parameter
      { token: defaulted, useFactory: true, dependencies: [T23Dep], provider: (ctx: { resolve<T>(token: unknown): T } = { resolve: () => { throw new Error('no context'); } }) => ((dep: T23Dep) => ({ n: dep.n }))(ctx.resolve(T23Dep)) },
      // resolveAll
      { token: listed, useFactory: true, dependencies: [{ all: items }], provider: (ctx) => ((all: T23Items[]) => ({ n: all.length }))(ctx.resolveAll(items)) },
`;

const CTX_ASYNC_BODY = `
      // async
      { token: later, useFactory: true, dependencies: [T23Dep], provider: async (ctx) => ((dep: T23Dep) => ({ n: dep.n }))(ctx.resolve(T23Dep)) },
`;

function ctxSource(profile: 'full' | 'minimal', optionLines: string, withAsync: boolean): string {
  return `
  ${STUB}
  export class T23Dep { n = 1; }
  interface T23Made { n: number }
  interface T23Items { n: number }
  interface T23Annotated { n: number }
  interface T23Defaulted { n: number }
  interface T23Listed { n: number }
  interface T23Later { n: number }
  const items = useInterface<T23Items>();
  const made = useInterface<T23Made>();
  const annotated = useInterface<T23Annotated>();
  const defaulted = useInterface<T23Defaulted>();
  const listed = useInterface<T23Listed>();
  const later = useInterface<T23Later>();
  export const box = defineBuilderConfig({
    name: 'T23Ctx',
    runtime: { profile: '${profile}' },
    ${optionLines}
    injections: [
      ${CTX_BODIES}
      ${withAsync ? CTX_ASYNC_BODY : ''}
    ],
  });
`;
}

/** A factory with no dependencies list: opaque, it may ask the container for any token. */
function opaqueSource(profile: 'full' | 'minimal'): string {
  return `
  ${STUB}
  export class T23Dep { n = 1; }
  interface T23Made { n: number }
  const made = useInterface<T23Made>();
  export const box = defineBuilderConfig({
    name: 'T23Opaque',
    runtime: { profile: '${profile}' },
    injections: [
      { token: T23Dep },
      { token: made, useFactory: true, provider: (ctx) => ((dep: T23Dep) => ({ n: dep.n }))(ctx.resolve(T23Dep)) },
    ],
  });
`;
}

function ctxCases(profile: 'full' | 'minimal'): EmissionCase[] {
  const base = { profile, testOverrides: false, parent: false, ambient: CTX_AMBIENT };
  const roots = 'T23Dep, made, annotated, defaulted, listed';
  const closed = `optimization: { mode: 'closed', roots: [${roots}] },`;
  const closedAsync = `optimization: { mode: 'closed', roots: [${roots}, later] },`;
  return [
    { ...base, name: `${profile} factory context open sync`, source: ctxSource(profile, '', false) },
    { ...base, name: `${profile} factory context open async`, source: ctxSource(profile, '', true) },
    { ...base, name: `${profile} factory context closed sync`, source: ctxSource(profile, closed, false) },
    { ...base, name: `${profile} factory context closed async`, source: ctxSource(profile, closedAsync, true) },
    {
      ...base,
      name: `${profile} factory context opaque`,
      source: opaqueSource(profile),
      validation: 'compatible' as const,
    },
  ];
}

function extraCases(profile: 'full' | 'minimal'): EmissionCase[] {
  const base = { profile, testOverrides: false, parent: false };
  return [
    { ...base, name: `${profile} multi sync`, source: MULTI_SOURCE },
    { ...base, name: `${profile} multi async`, source: MULTI_ASYNC_SOURCE },
    { ...base, name: `${profile} lifecycle sync`, source: LIFECYCLE_SOURCE },
    { ...base, name: `${profile} lifecycle async`, source: LIFECYCLE_ASYNC_SOURCE },
  ];
}

/**
 * Every matrix cell, the full cells again with `testOverrides` on (the override variant),
 * then multi registrations and disposable lifecycles in both profiles.
 */
export const CASES: readonly EmissionCase[] = [
  ...CELLS.map((cell) => ({
    name: cellName(cell),
    profile: cell.profile,
    source: sourceFor(cell),
    testOverrides: false,
    parent: cell.owner === 'parent',
  })),
  ...CELLS.filter((cell) => cell.profile === 'full').map((cell) => ({
    name: `${cellName(cell)} overrides`,
    profile: cell.profile,
    source: sourceFor(cell),
    testOverrides: true,
    parent: cell.owner === 'parent',
  })),
  ...extraCases('full'),
  ...extraCases('minimal'),
  ...ctxCases('full'),
  ...ctxCases('minimal'),
];

/** Title of one matrix cell, the same words as the `T00 ...` tests. */
function cellName(cell: ContractCell): string {
  return `${cell.profile} ${cell.mode} ${cell.timing} ${cell.owner}`;
}

export interface CaseEmission {
  emission: EmissionCase;
  emitter: ProductEmitter;
  /** Rendered output of the container `box`, and of its parent when the case has one. */
  outputs: readonly EmittedModule[];
  input: StrictInput;
}

/** What the consumer does with `box`: the public methods of the profile, nothing narrower than `unknown`. */
function consumerSource(profile: 'full' | 'minimal'): string {
  const full = profile === 'full';
  return [
    "import { box } from './box.out.ts';",
    '',
    // Copy of `Token` in packages/neosyringe/src/types.ts (Constructor | InterfaceToken | PropertyToken).
    ...(full
      ? [
          'type Token<T = unknown> =',
          '  | (new (...args: never[]) => T)',
          "  | { __brand: 'InterfaceToken'; __type: T }",
          "  | { __brand: 'PropertyToken'; __type: T; __class: unknown; __name: string };",
          '',
        ]
      : []),
    'export async function consume(token: unknown): Promise<void> {',
    '  await box.initialize();',
    '  const value: string = box.resolve<string>(token);',
    '  const every: number[] = box.resolveAll<number>(token);',
    '  const scope = box.createScope();',
    '  await scope.destroy();',
    '  await box.destroy();',
    ...(full
      ? [
          "  const stop: () => void = box.on('resolve', (resolved: unknown, instance: unknown) => {",
          '    void resolved;',
          '    void instance;',
          '  });',
          '  stop();',
          // The public listener shape of packages/neosyringe/src/types.ts: a consumer types its listener with it.
          "  const stopPublic: () => void = box.on('resolve', (resolved: Token<unknown>, instance: unknown) => {",
          '    void resolved;',
          '    void instance;',
          '  });',
          '  stopPublic();',
          '  await box.override(token, () => ({ n: 0 }));',
          '  await box.clearOverrides();',
        ]
      : []),
    '  void value;',
    '  void every;',
    '}',
    '',
  ].join('\n');
}

/**
 * Renders one case with `emitter`, laid out as a Program:
 * `<case>.ts` is the user file, `box.out.ts` the container output (and `parent.out.ts` when the case has a parent).
 * Imports are relative to the directory of the virtual user file, so they resolve.
 */
export function emitCase(emission: EmissionCase, emitter: ProductEmitter): CaseEmission {
  const userFile = `${emission.name.replace(/ /g, '-')}.ts`;
  const dir = `/virtual/t23/${emitter}`;
  const userPath = `${dir}/${userFile}`;
  const program = programOf(userPath, emission.source);
  const graphs = (emission.validation ? new Analyzer(program, { validation: emission.validation }) : new Analyzer(program)).extractAll();
  const render = (name: string): string =>
    new Generator(named(graphs, name), false, dirname(userPath), true, emission.testOverrides, emitter).generate();
  const outputs: EmittedModule[] = [{ file: 'box.out.ts', code: render('box') }];
  let ambient: string | undefined = emission.ambient;
  if (emission.parent) {
    outputs.push({ file: 'parent.out.ts', code: render('parent') });
    ambient = `${ambient ?? ''}declare const parent: typeof import('./parent.out.ts').parent;\n`;
  }
  const input: StrictInput = {
    dir,
    userSource: { file: userFile, text: emission.source },
    outputs,
    consumer: { file: 'consumer.ts', code: consumerSource(emission.profile) },
    ambient,
  };
  return { emission, emitter, outputs, input };
}
