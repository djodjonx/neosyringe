import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ASTVisitor } from '../../src/analyzer/visitors/ASTVisitor';

const MISSING_A = "missing: Missing injection: 'A' required by 'Svc' is not registered in this builder nor its parents/extends";

describe('T11 extends property access', () => {
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

function analyze(extendsExpr: 'part' | 'P.part' | 'N.nested.part' | 'P?.part'): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const partial = extendsExpr === 'part'
    ? 'const part = definePartialConfig({ injections: [{ token: A }] });'
    : extendsExpr === 'N.nested.part'
      ? 'namespace N { export namespace nested { export const part = definePartialConfig({ injections: [{ token: A }] }); } }'
      : 'namespace P { export const part = definePartialConfig({ injections: [{ token: A }] }); }';
  return analyzeSource([
    "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';",
    'class A {}',
    'class Svc { constructor(private a: A) {} }',
    partial,
    'export const container = defineBuilderConfig({',
    `  extends: [${extendsExpr}],`,
    '  injections: [{ token: Svc }],',
    '});',
    '',
  ].join('\n'));
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

function analyzeRenamed(): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const root = '/virtual/t11-extends';
  const files = new Map<string, string>([
    [`${root}/real.ts`, [
      "import { definePartialConfig } from '@djodjonx/neosyringe';",
      'export class A {}',
      'export const real = definePartialConfig({ injections: [{ token: A }] });',
      '',
    ].join('\n')],
    [`${root}/barrel.ts`, "export { real as part } from './real';\n"],
    [`${root}/app.ts`, [
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
  ]);
  return collect(createModuleProgram(files), `${root}/app.ts`);
}

function analyzeSource(source: string): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const program = createProgram({ 'app.ts': source });
  const app = program.getSourceFiles().find((sourceFile) => sourceFile.fileName.endsWith('app.ts'));
  if (!app) throw new Error('app.ts absent');
  return collect(program, app.fileName);
}

function collect(program: ts.Program, fileName: string): {
  errors: { type: string; message: string }[];
  fileErrors: { type: string; message: string }[];
  extendsReferences: ReadonlySet<string>;
} {
  const visitor = new ASTVisitor(program.getTypeChecker());
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) visitor.visit(sourceFile);
  }
  const analyzer = new Analyzer(program);
  return {
    errors: analyzer.extractAllErrors(),
    fileErrors: analyzer.extractForFile(fileName).errors,
    extendsReferences: visitor.getResults().extendsReferences,
  };
}

function createModuleProgram(files: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (fileName) => files.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => files.get(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, version, onError, shouldCreateNewSourceFile) => {
    const text = files.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, version, true);
    return readSource(fileName, version, onError, shouldCreateNewSourceFile);
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    if (moduleName.startsWith('.')) {
      const base = path.resolve(path.dirname(containingFile), moduleName);
      const candidate = files.has(base) ? base : `${base}.ts`;
      if (files.has(candidate)) {
        return {
          resolvedFileName: candidate,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  });
  return ts.createProgram([...files.keys()], options, host);
}

function createProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => {
    const key = Object.keys(files).find((file) => name.endsWith(file));
    if (key) return ts.createSourceFile(name, files[key], version, true);
    return readSource(name, version, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (file) => Object.keys(files).some((name) => file.endsWith(name)) || fileExists(file);
  return ts.createProgram(Object.keys(files), options, host);
}
