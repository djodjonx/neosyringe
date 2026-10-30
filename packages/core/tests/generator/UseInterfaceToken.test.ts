/**
 * Test: useInterface should generate consistent tokenId
 *
 * Whether useInterface is used:
 * 1. Directly inline: { token: useInterface<ILogger>(), ... }
 * 2. Via a const: const loggerToken = useInterface<ILogger>(); { token: loggerToken, ... }
 *
 * The generated tokenId should be the SAME and resolve() should work with both.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';

describe('useInterface Token Generation', () => {
  const generateCode = (fileContent: string) => {
    const fileName = 'useinterface-test.ts';
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

    const validator = new GraphValidator();
    validator.validate(graph);

    const generator = new Generator(graph);
    return generator.generate();
  };

  it('should generate resolve check with full tokenId including path', () => {
    const code = generateCode(`
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      export const c = defineBuilderConfig({
        name: 'App',
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });
    `);

    console.log('Generated code for ILogger:');
    console.log(code);

    // TokenId should include the file path to avoid collisions
    expect(code).toContain('ILogger_0b29e614');
    expect(code).toContain('if (token === "ILogger_0b29e614")');
  });

  it('should work with useInterface defined as const', () => {
    const code = generateCode(`
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IOperationTracker { operationId: string; }
      class OperationTracker implements IOperationTracker { operationId = '123'; }

      // Define token as const
      const operationTrackerToken = useInterface<IOperationTracker>();

      export const c = defineBuilderConfig({
        name: 'App',
        injections: [
          { token: operationTrackerToken, provider: OperationTracker, lifecycle: 'transient' }
        ]
      });
    `);

    console.log('Generated code for IOperationTracker (via const):');
    console.log(code);

    // Should generate the same tokenId whether inline or via const
    expect(code).toContain('IOperationTracker_abbe07a2');
    expect(code).toContain('if (token === "IOperationTracker_abbe07a2")');
  });

  it('should generate same tokenId for inline vs const useInterface', () => {
    // Test with inline
    const inlineCode = generateCode(`
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IEventBus { publish(event: any): void; }
      class InMemoryEventBus implements IEventBus { publish(event: any) {} }

      export const c = defineBuilderConfig({
        name: 'App',
        injections: [
          { token: useInterface<IEventBus>(), provider: InMemoryEventBus }
        ]
      });
    `);

    // Test with const
    const constCode = generateCode(`
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IEventBus { publish(event: any): void; }
      class InMemoryEventBus implements IEventBus { publish(event: any) {} }

      const eventBusToken = useInterface<IEventBus>();

      export const c = defineBuilderConfig({
        name: 'App',
        injections: [
          { token: eventBusToken, provider: InMemoryEventBus }
        ]
      });
    `);

    console.log('=== INLINE ===');
    console.log(inlineCode);
    console.log('=== CONST ===');
    console.log(constCode);

    // Both should generate the same tokenId with full path
    expect(inlineCode).toContain('IEventBus_67764429');
    expect(constCode).toContain('IEventBus_67764429');

    // Both should have identical resolve checks
    expect(inlineCode).toContain('if (token === "IEventBus_67764429")');
    expect(constCode).toContain('if (token === "IEventBus_67764429")');
  });
});

