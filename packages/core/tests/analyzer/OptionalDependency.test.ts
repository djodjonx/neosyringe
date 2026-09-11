import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';

/**
 * Optional dependencies: a constructor parameter marked `?` or typed
 * `T | undefined` is exempt from the "Missing injection" validator when
 * nothing registers it — it resolves to `undefined` at runtime instead of
 * failing the build. No new Injection field needed: this reuses the
 * constructor's own TypeScript syntax rather than adding a DI-specific
 * annotation.
 */
describe('Optional dependencies (build path — Analyzer.extract()/GraphValidator)', () => {
  const createProgram = (fileName: string, fileContent: string) => {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) return ts.createSourceFile(fileName, fileContent, languageVersion);
      return originalGetSourceFile(name, languageVersion);
    };
    return ts.createProgram([fileName], {}, compilerHost);
  };

  it('does not flag an unregistered `?` constructor param as missing', () => {
    const fileName = 'optional-question.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      interface ITelemetry { track(event: string): void; }
      class UserService {
        constructor(private telemetry?: ITelemetry) {}
      }
      export const container = defineBuilderConfig({
        injections: [{ token: UserService }]
      });
    `;
    const graph = new Analyzer(createProgram(fileName, fileContent)).extract();
    expect(() => new GraphValidator().validate(graph)).not.toThrow();

    const code = new Generator(graph, true).generate();
    expect(code).toContain('new UserService(undefined)');
  });

  it('does not flag an unregistered `T | undefined` constructor param as missing (under strictNullChecks)', () => {
    // Without strictNullChecks, TypeScript collapses `T | undefined` to `T` —
    // this union only survives as a real union under strict mode, which is
    // how virtually every real consumer project (and this repo itself) builds.
    const fileName = 'optional-union.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      interface ITelemetry { track(event: string): void; }
      class UserService {
        constructor(private telemetry: ITelemetry | undefined) {}
      }
      export const container = defineBuilderConfig({
        injections: [{ token: UserService }]
      });
    `;
    const compilerHost = ts.createCompilerHost({ strictNullChecks: true });
    const originalGetSourceFile = compilerHost.getSourceFile;
    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) return ts.createSourceFile(fileName, fileContent, languageVersion);
      return originalGetSourceFile(name, languageVersion);
    };
    const program = ts.createProgram([fileName], { strictNullChecks: true }, compilerHost);

    const graph = new Analyzer(program).extract();
    expect(() => new GraphValidator().validate(graph)).not.toThrow();
  });

  it('still flags a non-optional unregistered constructor param as missing', () => {
    const fileName = 'required.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      interface ITelemetry { track(event: string): void; }
      class UserService {
        constructor(private telemetry: ITelemetry) {}
      }
      export const container = defineBuilderConfig({
        injections: [{ token: UserService }]
      });
    `;
    const graph = new Analyzer(createProgram(fileName, fileContent)).extract();
    expect(() => new GraphValidator().validate(graph)).toThrow(/Missing injection.*ITelemetry/);
  });

  it('still wires an optional dependency normally when it IS registered', () => {
    const fileName = 'optional-registered.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }
      interface ITelemetry { track(event: string): void; }
      class Telemetry implements ITelemetry { track(event: string) {} }
      class UserService {
        constructor(private telemetry?: ITelemetry) {}
      }
      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<ITelemetry>(), provider: Telemetry },
          { token: UserService }
        ]
      });
    `;
    const graph = new Analyzer(createProgram(fileName, fileContent)).extract();
    expect(() => new GraphValidator().validate(graph)).not.toThrow();

    const code = new Generator(graph, true).generate();
    expect(code).toMatch(/new UserService\(this\.resolve\("ITelemetry_[a-f0-9]+"\)\)/);
  });
});
