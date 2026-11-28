import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { Generator } from '../../packages/core/src/generator/index';
import { GraphValidator } from '../../packages/core/src/generator/index';

describe('E2E - Local Tokens Object', () => {
  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'local-tokens.ts';

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

    const generator = new Generator(graph);
    return generator.generate();
  };

  it('should resolve local tokens object defined in the same file', () => {
    const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface IRequestContext { id: string; }
        interface IOperationTracker { id: string; }

        class RequestContext implements IRequestContext { id = '1'; }
        class OperationTracker implements IOperationTracker { id = '2'; }

        export const TOKENS = {
          IRequestContext: useInterface<IRequestContext>(),
          IOperationTracker: useInterface<IOperationTracker>(),
        };

        export const appContainer = defineBuilderConfig({
          name: 'AppContainer',
          injections: [
            {
              token: TOKENS.IRequestContext,
              provider: RequestContext,
              lifecycle: 'transient'
            },
            {
              token: TOKENS.IOperationTracker,
              provider: OperationTracker,
              lifecycle: 'transient'
            }
          ]
        });
    `);

        expect(code).toContain('IRequestContext_');

        expect(code).toContain('IOperationTracker_');

        // Ensure the accessors that build them are generated

        expect(code).toMatch(/_get_IRequestContext_/);

        expect(code).toMatch(/_get_IOperationTracker_/);

        // The accessors build the classes: the construction sits in them, not only their name in the output.

        expect(code).toMatch(/new \w+\.RequestContext\(/);

        expect(code).toMatch(/new \w+\.OperationTracker\(/);

      });

    });

