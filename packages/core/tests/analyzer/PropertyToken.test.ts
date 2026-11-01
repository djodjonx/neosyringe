import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - PropertyToken Support', () => {
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

  const findNodeByName = (graph: any, name: string, excludePropertyTokens = false) => {
    for (const [key, value] of graph.nodes) {
      if (excludePropertyTokens && key.startsWith('PropertyToken:')) continue;
      if (key.includes(name)) return { key, value };
    }
    return undefined;
  };

  const findPropertyToken = (graph: any, className: string, paramName: string) => {
    const prefix = `PropertyToken:${className}.${paramName}_`;
    for (const [key, value] of graph.nodes) {
      if (typeof key === 'string' && key.startsWith(prefix) && /^[0-9a-f]{8}$/.test(key.slice(prefix.length))) {
        return { key, value };
      }
    }
    return undefined;
  };

  const hasPropertyDependency = (deps: string[] | undefined, className: string, paramName: string) =>
    (deps ?? []).some((dependency) =>
      new RegExp(`^PropertyToken:${className}\\.${paramName}_[0-9a-f]{8}$`).test(dependency),
    );

  const findClassNode = (graph: any, className: string) => {
    for (const [key, value] of graph.nodes) {
      if (key === className || key.startsWith(`${className}_`)) {
        return { key, value };
      }
    }
    return undefined;
  };

  it('should detect useProperty(Class, paramName) token', () => {
    const fileName = 'property-token.ts';
    const fileContent = `
      import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private apiUrl: string, private maxRetries: number) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');
      const maxRetries = useProperty<number>(ApiService, 'maxRetries');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, dependencies: [], provider: () => 'http://localhost' },
          { token: maxRetries, dependencies: [], provider: () => 5 },
          { token: ApiService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should have PropertyToken nodes
    const apiUrlNode = findNodeByName(graph, 'ApiService.apiUrl');
    expect(apiUrlNode).toBeDefined();
    expect(apiUrlNode?.key).toMatch(/^PropertyToken:ApiService\.apiUrl_[0-9a-f]{8}$/);
    expect(apiUrlNode?.value.service.type).toBe('factory');
    expect(apiUrlNode?.value.service.isValueToken).toBe(true);

    const maxRetriesNode = findNodeByName(graph, 'ApiService.maxRetries');
    expect(maxRetriesNode).toBeDefined();
    expect(maxRetriesNode?.key).toMatch(/^PropertyToken:ApiService\.maxRetries_[0-9a-f]{8}$/);
  });

it('should auto-wire class with PropertyToken dependencies', () => {
    const fileName = 'property-autowire.ts';
    const fileContent = `
      import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private apiUrl: string) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, dependencies: [], provider: () => 'http://localhost' },
          { token: ApiService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // ApiService should have apiUrl as dependency
    const apiServiceNode = findClassNode(graph, 'ApiService');

    expect(apiServiceNode).toBeDefined();
    expect(hasPropertyDependency(apiServiceNode?.value.dependencies, 'ApiService', 'apiUrl')).toBe(true);
  });

  it('should not collide between different classes with same param name', () => {
    const fileName = 'property-no-collision.ts';
    const fileContent = `
      import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private url: string) {}
      }

      class AuthService {
        constructor(private url: string) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'url');
      const authUrl = useProperty<string>(AuthService, 'url');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, dependencies: [], provider: () => 'http://api.example.com' },
          { token: authUrl, dependencies: [], provider: () => 'http://auth.example.com' },
          { token: ApiService },
          { token: AuthService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should have 2 different PropertyTokens
    const apiUrlNode = findPropertyToken(graph, 'ApiService', 'url');
    const authUrlNode = findPropertyToken(graph, 'AuthService', 'url');

    expect(apiUrlNode?.key).toMatch(/^PropertyToken:ApiService\.url_[0-9a-f]{8}$/);
    expect(authUrlNode?.key).toMatch(/^PropertyToken:AuthService\.url_[0-9a-f]{8}$/);
    expect(apiUrlNode?.key).not.toBe(authUrlNode?.key);

    // Each class should reference its own token
    const apiServiceNode = findClassNode(graph, 'ApiService');
    const authServiceNode = findClassNode(graph, 'AuthService');

    expect(hasPropertyDependency(apiServiceNode?.value.dependencies, 'ApiService', 'url')).toBe(true);
    expect(hasPropertyDependency(authServiceNode?.value.dependencies, 'AuthService', 'url')).toBe(true);
  });

  it('should mix PropertyTokens with class dependencies', () => {
    const fileName = 'property-mixed.ts';
    const fileContent = `
      import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }

      class ApiService {
        constructor(
          private apiUrl: string,
          private logger: ILogger
        ) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, dependencies: [], provider: () => 'http://localhost' },
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
          { token: ApiService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const apiServiceNode = findClassNode(graph, 'ApiService');
    expect(apiServiceNode).toBeDefined();

    // Should have both PropertyToken and Interface as dependencies
    expect(hasPropertyDependency(apiServiceNode?.value.dependencies, 'ApiService', 'apiUrl')).toBe(true);
    expect(apiServiceNode?.value.dependencies.some((d: string) => d.includes('ILogger'))).toBe(true);
  });
});

