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
    const key = `PropertyToken:${className}.${paramName}`;
    const value = graph.nodes.get(key);
    return value ? { key, value } : undefined;
  };

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
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private apiUrl: string, private maxRetries: number) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');
      const maxRetries = useProperty<number>(ApiService, 'maxRetries');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, provider: () => 'http://localhost' },
          { token: maxRetries, provider: () => 5 },
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
    expect(apiUrlNode?.key).toBe('PropertyToken:ApiService.apiUrl');
    expect(apiUrlNode?.value.service.isFactory).toBe(true);
    expect(apiUrlNode?.value.service.isValueToken).toBe(true);

    const maxRetriesNode = findNodeByName(graph, 'ApiService.maxRetries');
    expect(maxRetriesNode).toBeDefined();
    expect(maxRetriesNode?.key).toBe('PropertyToken:ApiService.maxRetries');
  });

it('should auto-wire class with PropertyToken dependencies', () => {
    const fileName = 'property-autowire.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(private apiUrl: string) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');

      export const config = defineBuilderConfig({
        injections: [
          { token: apiUrl, provider: () => 'http://localhost' },
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
    expect(apiServiceNode?.value.dependencies).toContain('PropertyToken:ApiService.apiUrl');
  });

  it('should not collide between different classes with same param name', () => {
    const fileName = 'property-no-collision.ts';
    const fileContent = `
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
          { token: apiUrl, provider: () => 'http://api.example.com' },
          { token: authUrl, provider: () => 'http://auth.example.com' },
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

    expect(apiUrlNode?.key).toBe('PropertyToken:ApiService.url');
    expect(authUrlNode?.key).toBe('PropertyToken:AuthService.url');
    expect(apiUrlNode?.key).not.toBe(authUrlNode?.key);

    // Each class should reference its own token
    const apiServiceNode = findClassNode(graph, 'ApiService');
    const authServiceNode = findClassNode(graph, 'AuthService');

    expect(apiServiceNode?.value.dependencies).toContain('PropertyToken:ApiService.url');
    expect(authServiceNode?.value.dependencies).toContain('PropertyToken:AuthService.url');
  });

  it('should mix PropertyTokens with class dependencies', () => {
    const fileName = 'property-mixed.ts';
    const fileContent = `
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
          { token: apiUrl, provider: () => 'http://localhost' },
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
    expect(apiServiceNode?.value.dependencies).toContain('PropertyToken:ApiService.apiUrl');
    expect(apiServiceNode?.value.dependencies.some((d: string) => d.includes('ILogger'))).toBe(true);
  });
});

