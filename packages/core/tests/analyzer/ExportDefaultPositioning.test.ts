import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

/**
 * Regression test: `export default defineBuilderConfig({...})` was never
 * actually recognized by extract()/extractAll()'s real AST-based positioning.
 * `ExportAssignment.isExportEquals` is `undefined` for `export default expr`
 * (only `true` for CommonJS-style `export = expr`), but the check compared it
 * with strict `=== false`, which never matched. This was invisible before
 * because an unpositioned defineBuilderConfig() call was silently skipped
 * instead of erroring (see UnsupportedContainerShape.test.ts) — surfaced only
 * once that silent-skip was turned into a thrown error.
 */
describe('Analyzer — export default defineBuilderConfig() positioning', () => {
  const FILE = 'export-default.ts';

  function makeProgram(code: string) {
    const host = ts.createCompilerHost({});
    const orig = host.getSourceFile;
    host.getSourceFile = (name, version) =>
      name === FILE ? ts.createSourceFile(FILE, code, version) : orig(name, version);
    return ts.createProgram([FILE], {}, host);
  }

  const CODE = `
    function defineBuilderConfig(c: any): any { return c; }
    function useInterface<T>(): any { return null; }
    interface ILogger { log(msg: string): void; }
    class ConsoleLogger implements ILogger { log(msg: string) {} }

    export default defineBuilderConfig({
      injections: [
        { token: useInterface<ILogger>(), provider: ConsoleLogger },
      ],
    });
  `;

  it('extractAll() positions it and reports variableExportModifier "export default"', () => {
    const analyzer = new Analyzer(makeProgram(CODE));
    const graphs = analyzer.extractAll();
    expect(graphs).toHaveLength(1);
    expect(graphs[0].variableExportModifier).toBe('export default');
    expect(graphs[0].variableStatementStart).toBeDefined();
  });

  it('extract() (legacy path) also positions it without throwing', () => {
    const analyzer = new Analyzer(makeProgram(CODE));
    const graph = analyzer.extract();
    expect(graph.variableExportModifier).toBe('export default');
    expect(graph.nodes.size).toBe(1);
  });
});
