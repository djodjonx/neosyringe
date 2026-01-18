
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { Generator } from '../../packages/core/src/generator/index';
import { GraphValidator } from '../../packages/core/src/generator/index';

describe('E2E - Multi-File Tokens', () => {
  const compileAndGenerateMultiFile = (files: Record<string, string>) => {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (files[name]) {
        return ts.createSourceFile(name, files[name], languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    // Need to resolve modules for imports to work
    compilerHost.resolveModuleNames = (moduleNames) => {
        return moduleNames.map(moduleName => {
            // Simple resolution for our virtual files
            if (moduleName.startsWith('.')) {
                // assume flat structure for simplicity
                const resolvedName = moduleName.replace('./', '') + '.ts';
                if (files[resolvedName]) {
                    return {
                        resolvedFileName: resolvedName,
                        isExternalLibraryImport: false,
                        extension: ts.Extension.Ts
                    } as any;
                }
            }
            return undefined;
        });
    };

    const program = ts.createProgram(Object.keys(files), {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    validator.validate(graph);

    const generator = new Generator(graph);
    return generator.generate();
  };

  it('should resolve tokens exported from another file', () => {
    const files = {
      'tokens': `
        export function useInterface<T>(): any { return null; }
        export interface ILogger { log(msg: string): void; }
        export const TOKENS = {
          logger: useInterface<ILogger>()
        };
      `,
      'container': `
        import { TOKENS, ILogger } from './tokens';
        function defineBuilderConfig(config: any) { return config; }

        class ConsoleLogger implements ILogger { log(msg: string) {} }

        export const container = defineBuilderConfig({
          injections: [
            { token: TOKENS.logger, provider: ConsoleLogger }
          ]
        });
      `
    };

    const code = compileAndGenerateMultiFile(files);

    // Should resolve the interface token correctly
    expect(code).toMatch(/if \(token === ["'].*ILogger_.*["']\)/);
    expect(code).toContain('ConsoleLogger');
  });

  it('should resolve tokens from a partial config in another file', () => {
      const files = {
          'tokens': `
            export function useInterface<T>(): any { return null; }
            export interface IService {}
            export const SERVICE_TOKEN = useInterface<IService>();
          `,
          'partial': `
            import { SERVICE_TOKEN, IService } from './tokens';
            function definePartialConfig(config: any) { return config; }

            class ServiceImpl implements IService {}

            export const partial = definePartialConfig({
                injections: [
                    { token: SERVICE_TOKEN, provider: ServiceImpl }
                ]
            });
          `,
          'container': `
            import { partial } from './partial';
            function defineBuilderConfig(config: any) { return config; }

            export const container = defineBuilderConfig({
                extends: [partial]
            });
          `
      };

      const code = compileAndGenerateMultiFile(files);
      expect(code).toContain('ServiceImpl');
      expect(code).toMatch(/if \(token === ["'].*IService_.*["']\)/);
  });
});
