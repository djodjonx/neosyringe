import path from 'node:path';
import * as ts from 'typescript';

const ROOT = '/virtual/t09-capture';
const STUB = `${ROOT}/neo-stub.ts`;

const STUB_TEXT = [
  'export function defineBuilderConfig(config: object): object { return config; }',
  'export function definePartialConfig(config: object): object { return config; }',
  'export function useInterface<T>(): string { return "token"; }',
  '',
].join('\n');

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noLib: true,
  types: [],
  noEmit: true,
  baseUrl: ROOT,
  paths: { '@djodjonx/neosyringe': ['./neo-stub.ts'] },
};

/** In-memory modules. `@djodjonx/neosyringe` resolves to a marker stub. */
export function memoryProgram(files: ReadonlyMap<string, string>): ts.Program {
  const texts = new Map<string, string>([[STUB, STUB_TEXT], ...files]);
  const host = ts.createCompilerHost(OPTIONS);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getCurrentDirectory = () => ROOT;
  host.fileExists = (fileName) => texts.has(path.normalize(fileName)) || fileExists(fileName);
  host.readFile = (fileName) => texts.get(path.normalize(fileName)) ?? readFile(fileName);
  host.realpath = (fileName) => path.normalize(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = texts.get(path.normalize(fileName));
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const resolve = (moduleName: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    if (moduleName === '@djodjonx/neosyringe') {
      return { resolvedFileName: STUB, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    if (!moduleName.startsWith('.')) return undefined;
    const base = path.resolve(path.dirname(containingFile), moduleName);
    const candidate = texts.has(path.normalize(base)) ? base : `${base}.ts`;
    if (!texts.has(path.normalize(candidate))) return undefined;
    return { resolvedFileName: candidate, extension: ts.Extension.Ts, isExternalLibraryImport: false };
  };
  host.resolveModuleNames = (names, containingFile) => names.map((name) => resolve(name, containingFile));
  host.resolveModuleNameLiterals = (literals, containingFile) => literals.map((literal) => ({
    resolvedModule: resolve(literal.text, containingFile),
  }));
  return ts.createProgram([...files.keys()], OPTIONS, host);
}

export function captureRoot(name: string): string {
  return `${ROOT}/${name}`;
}
