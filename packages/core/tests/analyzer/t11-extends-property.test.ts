import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ASTVisitor } from '../../src/analyzer/visitors/ASTVisitor';

const MISSING_A = "missing: Missing injection: 'A' required by 'Svc' is not registered in this builder nor its parents/extends";

const ROOT = '/virtual/t11-extends';
const STUB_NAME = `${ROOT}/neo-stub.ts`;
const NEO_STUB = [
  'export function defineBuilderConfig(config: object): object { return config; }',
  'export function definePartialConfig(config: object): object { return config; }',
  '',
].join('\n');

// These fixtures only need the NeoSyringe markers. Default options parse lib.d.ts
// on every createProgram. One host caches those source files, and each program
// is built from the previous one.
const memoryFiles = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();
let sharedHost: ts.CompilerHost | undefined;
let previousProgram: ts.Program | undefined;
let caseIndex = 0;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  skipLibCheck: true,
  noLib: true,
  types: [],
  noEmit: true,
  baseUrl: ROOT,
  paths: {
    '@djodjonx/neosyringe': ['./neo-stub.ts'],
  },
};

describe('T11 extends property access', () => {
  afterAll(() => {
    memoryFiles.clear();
    sourceCache.clear();
    sharedHost = undefined;
    previousProgram = undefined;
    caseIndex = 0;
  });

  it('T11-R7-extends-property', () => {
    const identifier = analyze('part');
    const property = analyze('P.part');
    const nested = analyze('N.nested.part');
    const optional = analyze('P?.part');
    const renamed = analyzeRenamed();

    expect(signatures(property.errors)).toEqual(signatures(identifier.errors));
    expect(signatures(nested.errors)).toEqual(signatures(identifier.errors));
    expect(signatures(optional.errors)).toEqual(signatures(identifier.errors));
    expect(signatures(renamed.errors)).toEqual(signatures(identifier.errors));
    expect(signatures(identifier.errors)).toEqual([]);
    expect(signatures(property.fileErrors)).toEqual(signatures(identifier.fileErrors));
    expect(signatures(nested.fileErrors)).toEqual(signatures(identifier.fileErrors));
    expect(signatures(optional.fileErrors)).toEqual(signatures(identifier.fileErrors));
    expect(signatures(renamed.fileErrors)).toEqual(signatures(identifier.fileErrors));
    expect(signatures(identifier.fileErrors)).toEqual([]);
    expect(identifier.extendsReferences.has('part')).toBe(true);
    expect(property.extendsReferences.has('part')).toBe(true);
    expect(nested.extendsReferences.has('part')).toBe(true);
    expect(optional.extendsReferences.has('part')).toBe(true);
    expect(renamed.extendsReferences.has('real')).toBe(true);
  });

  it('T11-R9-extends-unbound', () => {
    for (const source of unboundSources()) {
      const result = analyzeSource(source);
      expect(signatures(result.errors)).toEqual([MISSING_A]);
      expect(signatures(result.fileErrors)).toEqual([MISSING_A]);
    }
  });
});

function signatures(errors: { type: string; message: string }[]): string[] {
  return errors.map((error) => `${error.type}: ${error.message}`).sort();
}

function sourceFor(extendsExpr: 'part' | 'P.part' | 'N.nested.part' | 'P?.part'): string {
  const partial = extendsExpr === 'part'
    ? 'const part = definePartialConfig({ injections: [{ token: A }] });'
    : extendsExpr === 'N.nested.part'
      ? 'namespace N { export namespace nested { export const part = definePartialConfig({ injections: [{ token: A }] }); } }'
      : 'namespace P { export const part = definePartialConfig({ injections: [{ token: A }] }); }';
  return [
    "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';",
    'class A {}',
    'class Svc { constructor(private a: A) {} }',
    partial,
    'export const container = defineBuilderConfig({',
    `  extends: [${extendsExpr}],`,
    '  injections: [{ token: Svc }],',
    '});',
    '',
  ].join('\n');
}

function analyze(extendsExpr: 'part' | 'P.part' | 'N.nested.part' | 'P?.part'): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const fileName = `${ROOT}/case-${caseIndex}.ts`;
  caseIndex += 1;
  return collect(programFor(new Map([[fileName, sourceFor(extendsExpr)]])), fileName);
}

function analyzeRenamed(): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const fileName = `${ROOT}/app.ts`;
  return collect(programFor(new Map([
    [`${ROOT}/real.ts`, [
      "import { definePartialConfig } from '@djodjonx/neosyringe';",
      'export class A {}',
      'export const real = definePartialConfig({ injections: [{ token: A }] });',
      '',
    ].join('\n')],
    [`${ROOT}/barrel.ts`, "export { real as part } from './real';\n"],
    [fileName, [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      "import * as N from './barrel';",
      "import { A } from './real';",
      'class Svc { constructor(private a: A) {} }',
      'export const container = defineBuilderConfig({',
      '  extends: [N.part],',
      '  injections: [{ token: Svc }],',
      '});',
      '',
    ].join('\n')],
  ])), fileName);
}

function unboundSources(): string[] {
  const prelude = [
    "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';",
    'class A {}',
    'class Svc { constructor(private a: A) {} }',
    'const part = definePartialConfig({ injections: [{ token: A }] });',
  ];
  const body = (middle: string[], extendsExpr: string): string => [
    ...prelude,
    ...middle,
    'export const container = defineBuilderConfig({',
    `  extends: [${extendsExpr}],`,
    '  injections: [{ token: Svc }],',
    '});',
    '',
  ].join('\n');
  return [
    body(['const P = { part };'], 'P.part'),
    body(['const real = 1;', 'const P = { part: real };'], 'P.part'),
    body([], 'this.part'),
    body([], 'Q.part'),
  ];
}

function analyzeSource(source: string): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const fileName = `${ROOT}/unbound-${caseIndex}.ts`;
  caseIndex += 1;
  return collect(programFor(new Map([[fileName, source]])), fileName);
}

function collect(program: ts.Program, fileName: string): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const app = program.getSourceFile(fileName);
  if (!app) throw new Error(`fichier absent: ${fileName}`);
  const visitor = new ASTVisitor(program.getTypeChecker());
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visitor.visit(sourceFile);
  }
  const analyzer = new Analyzer(program);
  return {
    errors: analyzer.extractAllErrors(),
    fileErrors: analyzer.extractForFile(app.fileName).errors,
    extendsReferences: visitor.getResults().extendsReferences,
  };
}

function remember(fileName: string, text: string): void {
  const key = path.normalize(fileName);
  if (memoryFiles.get(key) !== text) sourceCache.delete(key);
  memoryFiles.set(key, text);
}

function textOf(fileName: string): string | undefined {
  return memoryFiles.get(path.normalize(fileName));
}

function resolvedModule(moduleName: string, containingFile: string): ts.ResolvedModuleFull | undefined {
  if (moduleName === '@djodjonx/neosyringe') {
    return {
      resolvedFileName: STUB_NAME,
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };
  }
  if (moduleName.startsWith('.')) {
    const base = path.resolve(path.dirname(containingFile), moduleName);
    const candidate = textOf(base) !== undefined ? base : `${base}.ts`;
    if (textOf(candidate) !== undefined) {
      return {
        resolvedFileName: candidate,
        extension: ts.Extension.Ts,
        isExternalLibraryImport: false,
      };
    }
  }
  return undefined;
}

function hostFor(options: ts.CompilerOptions): ts.CompilerHost {
  if (sharedHost) return sharedHost;
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const realpath = host.realpath?.bind(host);
  host.getCurrentDirectory = () => ROOT;
  host.directoryExists = (directoryName) => {
    const name = path.normalize(directoryName);
    if (name === ROOT || name.startsWith(`${ROOT}${path.sep}`)) return true;
    return directoryExists?.(directoryName) ?? false;
  };
  host.fileExists = (fileName) => textOf(fileName) !== undefined || fileExists(fileName);
  host.readFile = (fileName) => textOf(fileName) ?? readFile(fileName);
  host.realpath = (fileName) => {
    if (textOf(fileName) !== undefined) return path.normalize(fileName);
    return realpath ? realpath(fileName) : fileName;
  };
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = path.normalize(fileName);
    const text = textOf(fileName);
    if (!shouldCreateNewSourceFile) {
      const hit = sourceCache.get(key);
      if (hit && (text === undefined || hit.text === text)) return hit;
    }
    const created = text !== undefined
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (created && !shouldCreateNewSourceFile) sourceCache.set(path.normalize(created.fileName), created);
    return created;
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => (
    resolvedModule(moduleName, containingFile)
  ));
  sharedHost = host;
  return host;
}

function programFor(files: ReadonlyMap<string, string>): ts.Program {
  remember(STUB_NAME, NEO_STUB);
  for (const [fileName, text] of files) remember(fileName, text);
  const program = ts.createProgram([...files.keys()], OPTIONS, hostFor(OPTIONS), previousProgram);
  previousProgram = program;
  return program;
}
