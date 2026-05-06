import * as ts from 'typescript';

/**
 * Creates a TypeScript program with a single virtual (in-memory) source file.
 * Use this in tests instead of writing custom createProgram helpers.
 *
 * @param fileName - The virtual file name (e.g., 'test.ts')
 * @param content - The TypeScript source code for the virtual file
 * @param options - Compiler options (defaults to ES2020/CommonJS/strict for new tests).
 *   Pass `{}` to match existing test helpers that use TypeScript defaults.
 * @returns A ts.Program containing only the virtual file
 */
export function createVirtualProgram(
  fileName: string,
  content: string,
  options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
  }
): ts.Program {
  const compilerHost = ts.createCompilerHost(options);
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  compilerHost.getSourceFile = (name, languageVersion) => {
    if (name === fileName) {
      return ts.createSourceFile(fileName, content, languageVersion, true);
    }
    return originalGetSourceFile(name, languageVersion);
  };
  return ts.createProgram([fileName], options, compilerHost);
}
