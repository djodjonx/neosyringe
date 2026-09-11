import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer, UnsupportedContainerShapeError } from '../../src/analyzer/Analyzer';

/**
 * Regression tests for: a `defineBuilderConfig(...)` call whose position can't
 * be statically determined (e.g. a bare `return defineBuilderConfig({...})`
 * with no intermediate variable) used to be silently skipped — no graph, no
 * error, no generated container. The `defineBuilderConfig(...)` call shipped
 * untransformed, breaking at runtime with zero indication the build plugin
 * ever saw it. Both extract() and extractAll() must now fail loudly instead.
 */
describe('Analyzer — unsupported defineBuilderConfig() shapes', () => {
  const FILE = 'unsupported-shape.ts';

  function makeProgram(code: string) {
    const host = ts.createCompilerHost({});
    const orig = host.getSourceFile;
    host.getSourceFile = (name, version) =>
      name === FILE ? ts.createSourceFile(FILE, code, version) : orig(name, version);
    return ts.createProgram([FILE], {}, host);
  }

  const BARE_RETURN_CODE = `
    function defineBuilderConfig(c: any): any { return c; }
    function useInterface<T>(): any { return null; }
    interface ILogger { log(msg: string): void; }
    class ConsoleLogger implements ILogger { log(msg: string) {} }

    export function buildContainer() {
      return defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
        ],
      });
    }
  `;

  it('extractAll() throws UnsupportedContainerShapeError for a bare return', () => {
    const analyzer = new Analyzer(makeProgram(BARE_RETURN_CODE));
    expect(() => analyzer.extractAll()).toThrow(UnsupportedContainerShapeError);
    expect(() => analyzer.extractAll()).toThrow(/must be assigned to a variable/);
  });

  it('extract() (legacy path, used by the ts-patch transformer) also throws for a bare return', () => {
    const analyzer = new Analyzer(makeProgram(BARE_RETURN_CODE));
    expect(() => analyzer.extract()).toThrow(UnsupportedContainerShapeError);
  });

  it('does not throw for the supported const-then-return shape', () => {
    const code = `
      function defineBuilderConfig(c: any): any { return c; }
      function useInterface<T>(): any { return null; }
      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      export function buildContainer() {
        const container = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
          ],
        });
        return container;
      }
    `;
    const analyzer = new Analyzer(makeProgram(code));
    expect(() => analyzer.extractAll()).not.toThrow();
    expect(() => new Analyzer(makeProgram(code)).extract()).not.toThrow();
  });

  it('does not throw for export default defineBuilderConfig(...)', () => {
    const code = `
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
    const analyzer = new Analyzer(makeProgram(code));
    expect(() => analyzer.extractAll()).not.toThrow();
    expect(() => new Analyzer(makeProgram(code)).extract()).not.toThrow();
  });
});
