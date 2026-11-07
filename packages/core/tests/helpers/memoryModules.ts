import * as ts from 'typescript';
import { hasText, textAt, tsPath, virtualResolved } from './tsPath';

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
  host.fileExists = (fileName) => hasText(texts, fileName) || fileExists(fileName);
  host.readFile = (fileName) => textAt(texts, fileName) ?? readFile(fileName);
  host.realpath = (fileName) => (hasText(texts, fileName) ? tsPath(fileName) : fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textAt(texts, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const resolve = (moduleName: string, containingFile: string): ts.ResolvedModuleFull | undefined => {
    if (moduleName === '@djodjonx/neosyringe') {
      return { resolvedFileName: STUB, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    const candidate = virtualResolved(texts, containingFile, moduleName);
    if (candidate === undefined) return undefined;
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
