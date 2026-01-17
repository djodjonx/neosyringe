import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - Factory Support', () => {
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

  const findNodeByName = (graph: any, name: string) => {
    for (const [key, value] of graph.nodes) {
      if (key.includes(name)) return value;
    }
    return undefined;
  };

  const hasNodeWithName = (graph: any, name: string) => {
    for (const key of graph.nodes.keys()) {
      if (key.includes(name)) return true;
    }
    return false;
  };

  it('should detect arrow function factory with useFactory: true', () => {
    const fileName = 'factory-explicit.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IConfig {
        apiUrl: string;
      }

      export const config = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IConfig>(),
            provider: (container: any) => ({ apiUrl: 'http://api.example.com' }),
            useFactory: true
          }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    expect(hasNodeWithName(graph, 'IConfig')).toBe(true);

    const node = findNodeByName(graph, 'IConfig');
    expect(node?.service.isFactory).toBe(true);
    expect(node?.service.type).toBe('factory');
    expect(node?.service.factorySource).toContain('apiUrl');
  });

  it('should auto-detect arrow function as factory without useFactory flag', () => {
    const fileName = 'factory-auto.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IDatabase {
        connect(): void;
      }

      export const config = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: (c: any) => {
              return { connect: () => console.log('connected') };
            }
          }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    expect(hasNodeWithName(graph, 'IDatabase')).toBe(true);

    const node = findNodeByName(graph, 'IDatabase');
    expect(node?.service.isFactory).toBe(true);
    expect(node?.service.type).toBe('factory');
  });

  it('should detect factory with class dependency', () => {
    const fileName = 'factory-deps.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      interface IService { run(): void; }

      class ConsoleLogger implements ILogger {
        log(msg: string) { console.log(msg); }
      }

      export const config = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
          {
            token: useInterface<IService>(),
            provider: (container: any) => {
              const logger = container.resolve('ILogger');
              return { run: () => logger.log('running') };
            }
          }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    expect(hasNodeWithName(graph, 'ILogger')).toBe(true);
    expect(hasNodeWithName(graph, 'IService')).toBe(true);

    const serviceNode = findNodeByName(graph, 'IService');
    expect(serviceNode?.service.isFactory).toBe(true);
    expect(serviceNode?.service.factorySource).toContain('container.resolve');
  });

  it('should support factory with transient scope', () => {
    const fileName = 'factory-transient.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IRequest { id: number; }

      let counter = 0;

      export const config = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IRequest>(),
            provider: () => ({ id: ++counter }),
            lifecycle: 'transient'
          }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const node = findNodeByName(graph, 'IRequest');
    expect(node?.service.isFactory).toBe(true);
    expect(node?.service.lifecycle).toBe('transient');
  });

  it('should not treat class as factory', () => {
    const fileName = 'not-factory.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }

      class UserService {}

      export const config = defineBuilderConfig({
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const node = findNodeByName(graph, 'UserService');
    expect(node?.service.isFactory).toBeFalsy();
    expect(node?.service.type).toBe('autowire');
  });
});

