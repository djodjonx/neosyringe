import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - Declarative Config (defineBuilderConfig)', () => {
  it('should extract injections from defineBuilderConfig', () => {
    const fileName = 'config-v2.ts';
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class Logger {}
      class UserService { constructor(l: Logger) {} }

      export const config = defineBuilderConfig({
        injections: [
          { token: Logger },
          { token: UserService }
        ]
      });
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
        if (name === fileName) {
            return ts.createSourceFile(fileName, fileContent, languageVersion);
        }
        return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const findKey = (name: string) => Array.from(graph.nodes.keys()).find((k: any) => k.includes(name));

    // Verify nodes
    expect(findKey('Logger')).toBeDefined();
    expect(findKey('UserService')).toBeDefined();

    // Verify dependency
    const userNode = graph.nodes.get(findKey('UserService')!);
    expect(userNode?.dependencies[0]).toContain('Logger');
  });

  it('should handle useInterface tokens', () => {
    const fileName = 'interface-v2.ts';
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface ILogger { log(): void; }
      class ConsoleLogger implements ILogger { log() {} }

      export const config = defineBuilderConfig({
        injections: [
          {
            token: useInterface<ILogger>(),
            provider: ConsoleLogger
          }
        ]
      });
    `;

    // For this test to work, we need to mock how Analyzer generates IDs for interfaces.
    // Let's assume it uses "InterfaceName" for now or verify it extracts *something*.

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
        if (name === fileName) {
            return ts.createSourceFile(fileName, fileContent, languageVersion);
        }
        return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // We expect the Analyzer to have found the implementation ConsoleLogger
    // associated with a token derived from ILogger.

    // Since we don't know the ID yet, let's iterate.
    const nodes = Array.from(graph.nodes.values());
    const loggerNode = nodes.find(n => n.service.implementationSymbol?.getName() === 'ConsoleLogger');

    expect(loggerNode).toBeDefined();
    expect(loggerNode?.service.type).toBe('explicit');
    // The Token ID should be related to ILogger
    expect(loggerNode?.service.tokenId).toContain('ILogger');
  });
});
