import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';

/**
 * Regression tests for: a constructor dependency satisfied by a `useContainer`
 * parent (or `declareContainerTokens` legacy) container passed the validator
 * (GraphValidator saw the token in parentProvidedTokens) but FactoryEmitter had
 * no branch for parent-provided tokens and silently emitted `undefined` as the
 * constructor argument — a silent runtime wiring bug with no build error.
 */
describe('FactoryEmitter — parent/legacy container wiring', () => {
  const createProgram = (fileName: string, fileContent: string) => {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fileContent, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    return ts.createProgram([fileName], {}, compilerHost);
  };

  it('wires an interface-token dependency satisfied by a useContainer parent via this.resolve(), not undefined', () => {
    const fileName = 'parent-wiring.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }

      const sharedKernel = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      class UserService {
        constructor(private logger: ILogger) {}
      }

      export const childContainer = defineBuilderConfig({
        useContainer: sharedKernel,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    new GraphValidator().validate(graph); // must not throw

    const code = new Generator(graph, true).generate();

    expect(code).not.toContain('new UserService(undefined)');
    expect(code).toMatch(/new UserService\(this\.resolve\("ILogger_[a-f0-9]+"\)\)/);
  });

  it('wires a dependency satisfied by a declareContainerTokens legacy container via this.resolve()', () => {
    const fileName = 'legacy-wiring.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function declareContainerTokens<T>(container: any): T { return container; }

      class AuthService { validate() { return true; } }

      const legacyContainer = {};
      const legacy = declareContainerTokens<{ AuthService: AuthService }>(legacyContainer);

      class UserService {
        constructor(private auth: AuthService) {}
      }

      export const app = defineBuilderConfig({
        useContainer: legacy,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    new GraphValidator().validate(graph);

    const code = new Generator(graph, true).generate();

    expect(code).not.toContain('new UserService(undefined)');
    expect(code).toMatch(/new UserService\(this\.resolve\("AuthService_[a-f0-9]+"\)\)/);
  });

  it('throws a clear build error instead of silently emitting undefined for a bare class token from the parent', () => {
    const fileName = 'parent-class-token.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }

      class SharedRepo { find() { return null; } }

      const sharedKernel = defineBuilderConfig({
        injections: [
          { token: SharedRepo }
        ]
      });

      class UserService {
        constructor(private repo: SharedRepo) {}
      }

      export const childContainer = defineBuilderConfig({
        useContainer: sharedKernel,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // The validator considers this satisfied (SharedRepo is in parentProvidedTokens)...
    expect(() => new GraphValidator().validate(graph)).not.toThrow();

    // ...but codegen cannot safely wire a class-identity token across containers,
    // and must fail loudly rather than emit `new UserService(undefined)`.
    expect(() => new Generator(graph, true).generate()).toThrow(/Cannot wire dependency 'SharedRepo'/);
  });
});
