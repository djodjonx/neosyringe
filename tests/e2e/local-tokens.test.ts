import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { GraphValidator } from '../../src/generator/GraphValidator';

describe('E2E - Local Tokens Object', () => {
  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'local-tokens.ts';
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
    
        // Ensure factories are generated
    
        expect(code).toMatch(/create_IRequestContext_/);
    
        expect(code).toMatch(/create_IOperationTracker_/);
    
      });
    
    });
    
    