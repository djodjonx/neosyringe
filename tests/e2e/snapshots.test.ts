/**
 * Snapshot Tests - Generated Code
 *
 * These tests verify that the generated code matches expected snapshots.
 * This catches regressions in the code generation.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { GraphValidator } from '../../packages/core/src/generator/index';
import { Generator } from '../../packages/core/src/generator/index';

describe('Generated Code Snapshots', () => {
  const generateCode = (fileContent: string, emitter?: 'reference' | 'optimized') => {
    const fileName = 'snapshot-test.ts';

    const fullContent = `
      import { defineBuilderConfig, definePartialConfig, useInterface, useProperty, declareContainerTokens } from '@djodjonx/neosyringe';
      ${fileContent}
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fullContent, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    validator.validate(graph);

    const generator = new Generator(graph, false, undefined, true, false, emitter);
    return generator.generate();
  };

  it('should match snapshot for simple service', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      class SimpleService { getValue() { return 42; } }
      export const c = defineBuilderConfig({
        name: 'SimpleApp',
        injections: [{ token: SimpleService }]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for service with dependencies', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      class Logger {}
      class UserService { constructor(logger: Logger) {} }
      export const c = defineBuilderConfig({
        name: 'UserApp',
        injections: [
          { token: Logger },
          { token: UserService }
        ]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for interface tokens', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      export const c = defineBuilderConfig({
        name: 'InterfaceApp',
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for mixed scopes', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      class SingletonService {}
      class TransientService {}
      export const c = defineBuilderConfig({
        name: 'ScopesApp',
        injections: [
          { token: SingletonService, lifecycle: 'singleton' },
          { token: TransientService, lifecycle: 'transient' }
        ]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for parent container', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger {}
      class ConsoleLogger implements ILogger {}

      const parent = defineBuilderConfig({
        injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
      });

      class AppService {}

      export const c = defineBuilderConfig({
        name: 'ChildApp',
        useContainer: parent,
        injections: [{ token: AppService }]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for legacy container', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      function declareContainerTokens<T>(c: any): T { return c; }

      class LegacyService {}
      const tsyringe = {};
      const legacy = declareContainerTokens<{ LegacyService: LegacyService }>(tsyringe);

      class NewService { constructor(l: LegacyService) {} }

      export const c = defineBuilderConfig({
        name: 'LegacyApp',
        useContainer: legacy,
        injections: [{ token: NewService }]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for property tokens', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private apiUrl: string) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');

      export const c = defineBuilderConfig({
        name: 'PropertyApp',
        injections: [
          { token: apiUrl, dependencies: [], provider: () => 'http://localhost' },
          { token: ApiService }
        ]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  it('should match snapshot for complex real-world scenario', () => {
    const code = generateCode(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      // Interfaces
      interface ILogger { log(msg: string): void; }
      interface IDatabase { query(sql: string): any; }
      interface ICache { get(key: string): any; }

      // Implementations
      class ConsoleLogger implements ILogger { log(msg: string) {} }
      class PostgresDB implements IDatabase {
        constructor(private logger: ILogger) {}
        query(sql: string) { return []; }
      }
      class RedisCache implements ICache {
        constructor(private logger: ILogger) {}
        get(key: string) { return null; }
      }

      // Services
      class UserRepository {
        constructor(private db: IDatabase, private cache: ICache) {}
      }

      class UserService {
        constructor(
          private repo: UserRepository,
          private logger: ILogger
        ) {}
      }

      class AuthService {
        constructor(
          private userService: UserService,
          private logger: ILogger
        ) {}
      }

      export const c = defineBuilderConfig({
        name: 'RealWorldApp',
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
          { token: useInterface<IDatabase>(), provider: PostgresDB },
          { token: useInterface<ICache>(), provider: RedisCache },
          { token: UserRepository },
          { token: UserService },
          { token: AuthService }
        ]
      });
    `);

    expect(code).toMatchSnapshot();
  });

  // A container with scope inputs (topic 18): the model, its plan, the bound guards and the releasing destroy.
  const SCOPE_INPUTS = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      interface IRequest { id: string; }
      class Handler {
        constructor(private request: IRequest, private retries: number) {}
      }

      export const c = defineBuilderConfig({
        name: 'ScopeInputsApp',
        scopeInputs: [useInterface<IRequest>(), useProperty<number>(Handler, 'retries')],
        injections: [{ token: Handler }]
      });
    `;

  it('should match snapshot for scope inputs, reference emitter', () => {
    expect(generateCode(SCOPE_INPUTS, 'reference')).toMatchSnapshot();
  });

  it('should match snapshot for scope inputs, optimized emitter', () => {
    expect(generateCode(SCOPE_INPUTS, 'optimized')).toMatchSnapshot();
  });
  // A container with aliases (topic 20): a target, an alias of it, an alias of that alias, and a consumer of the alias
  // token. Both emitters, both profiles, open and closed: an alias has an accessor and no creator, no state, no disposal.
  const aliasSource = (options: string) => `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { id: string; }
      interface IAudit { id: string; }
      class ConsoleLogger { id = 'console'; }
      class Reader {
        constructor(private logger: ILogger) {}
      }

      export const c = defineBuilderConfig({
        name: 'AliasApp',
        ${options}
        injections: [
          { token: ConsoleLogger },
          { token: useInterface<ILogger>(), useExisting: ConsoleLogger },
          { token: useInterface<IAudit>(), useExisting: useInterface<ILogger>() },
          { token: Reader }
        ]
      });
    `;

  const ALIAS_PROFILES: ReadonlyArray<readonly [string, string]> = [
    ['full', ''],
    ['minimal', "runtime: { profile: 'minimal' },"],
  ];
  const ALIAS_MODES: ReadonlyArray<readonly [string, string]> = [
    ['open', ''],
    ['closed', "optimization: { mode: 'closed', roots: [Reader, useInterface<IAudit>()] },"],
  ];

  for (const emitter of ['reference', 'optimized'] as const) {
    for (const [profile, runtime] of ALIAS_PROFILES) {
      for (const [mode, optimization] of ALIAS_MODES) {
        it(`should match snapshot for aliases, ${emitter} emitter, ${profile} ${mode}`, () => {
          expect(generateCode(aliasSource(`${runtime} ${optimization}`), emitter)).toMatchSnapshot();
        });
      }
    }
  }
});

