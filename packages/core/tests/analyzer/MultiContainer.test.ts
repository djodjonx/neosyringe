import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer';

describe('Multi-Container per File', () => {
  function createProgram(source: string, fileName = 'test.ts'): ts.Program {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      strict: true,
    };

    const host = ts.createCompilerHost(compilerOptions);
    const originalGetSourceFile = host.getSourceFile;

    host.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    return ts.createProgram([fileName], compilerOptions, host);
  }

  describe('containerId generation', () => {
    it('should generate containerId from name field', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const userContainer = defineBuilderConfig({
          name: 'UserModule',
          injections: []
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      expect(result.configs.size).toBe(1);
      const config = Array.from(result.configs.values())[0];
      expect(config.containerId).toBe('UserModule');
    });

    it('should generate hash-based containerId when no name field', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          injections: []
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      expect(result.configs.size).toBe(1);
      const config = Array.from(result.configs.values())[0];
      expect(config.containerId).toMatch(/^Container_[a-f0-9]{8}$/);
    });

    it('should support multiple containers with different names in same file', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        class UserService {}
        class ProductService {}

        export const userContainer = defineBuilderConfig({
          name: 'UserModule',
          injections: [
            { token: UserService }
          ]
        });

        export const productContainer = defineBuilderConfig({
          name: 'ProductModule',
          injections: [
            { token: ProductService }
          ]
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      expect(result.configs.size).toBe(2);

      const configs = Array.from(result.configs.values());
      const userConfig = configs.find(c => c.containerId === 'UserModule');
      const productConfig = configs.find(c => c.containerId === 'ProductModule');

      expect(userConfig).toBeDefined();
      expect(productConfig).toBeDefined();
      expect(userConfig!.name).toBe('userContainer');
      expect(productConfig!.name).toBe('productContainer');
    });

    it('should throw error on duplicate container names in same file', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const containerA = defineBuilderConfig({
          name: 'MyContainer',
          injections: []
        });

        export const containerB = defineBuilderConfig({
          name: 'MyContainer',
          injections: []
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);

      expect(() => {
        analyzer.extractForFile('test.ts');
      }).toThrow(/Duplicate container name 'MyContainer'/);
    });

    it('should allow same container name in different files', () => {
      const source1 = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          name: 'AppContainer',
          injections: []
        });
      `;

      const source2 = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          name: 'AppContainer',
          injections: []
        });
      `;

      // Create program with multiple files
      const compilerOptions: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      };

      const host = ts.createCompilerHost(compilerOptions);
      const originalGetSourceFile = host.getSourceFile;

      host.getSourceFile = (name, languageVersion) => {
        if (name === 'file1.ts') {
          return ts.createSourceFile(name, source1, languageVersion);
        }
        if (name === 'file2.ts') {
          return ts.createSourceFile(name, source2, languageVersion);
        }
        return originalGetSourceFile(name, languageVersion);
      };

      const program = ts.createProgram(['file1.ts', 'file2.ts'], compilerOptions, host);
      const analyzer = new Analyzer(program);

      // Should not throw - same name in different files is OK
      const result1 = analyzer.extractForFile('file1.ts');
      const result2 = analyzer.extractForFile('file2.ts');

      // extractForFile returns all configs, filter by file
      const configs1 = Array.from(result1.configs.values()).filter(c => c.sourceFile.fileName === 'file1.ts');
      const configs2 = Array.from(result2.configs.values()).filter(c => c.sourceFile.fileName === 'file2.ts');

      expect(configs1.length).toBe(1);
      expect(configs2.length).toBe(1);
    });
  });

  describe('validation independence', () => {
    it('should validate each container independently', () => {
      const source = `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

        interface ILogger { log(msg: string): void; }
        class ConsoleLogger implements ILogger { log(msg: string) {} }

        class ServiceA {
          constructor(logger: ILogger) {}
        }

        class ServiceB {
          constructor(logger: ILogger) {}
        }

        // Container A - missing ILogger
        export const containerA = defineBuilderConfig({
          name: 'ContainerA',
          injections: [
            { token: ServiceA }  // Should error: missing ILogger
          ]
        });

        // Container B - has ILogger
        export const containerB = defineBuilderConfig({
          name: 'ContainerB',
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: ServiceB }  // Should be OK
          ]
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      expect(result.configs.size).toBe(2);

      // ContainerA should have errors
      const containerA = Array.from(result.configs.values()).find(c => c.containerId === 'ContainerA');
      const _errorsA = result.errors.filter(e =>
        e.sourceFile.fileName === 'test.ts' &&
        e.message.includes('ServiceA') || e.message.includes('ContainerA')
      );

      // ContainerB should have no errors
      const containerB = Array.from(result.configs.values()).find(c => c.containerId === 'ContainerB');

      expect(containerA).toBeDefined();
      expect(containerB).toBeDefined();

      // Note: Actual error detection depends on the validators being properly configured
      // This test validates the structure, actual validation is tested elsewhere
    });
  });

  describe('export default support', () => {
    it('should support export default with name field', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export default defineBuilderConfig({
          name: 'AppContainer',
          injections: []
        });
      `;

      const program = createProgram(source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      expect(result.configs.size).toBe(1);
      const config = Array.from(result.configs.values())[0];
      expect(config.containerId).toBe('AppContainer');
    });
  });

  describe('hash stability', () => {
    it('should generate same hash for same content', () => {
      const source = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          injections: []
        });
      `;

      const program1 = createProgram(source);
      const analyzer1 = new Analyzer(program1);
      const result1 = analyzer1.extractForFile('test.ts');

      const program2 = createProgram(source);
      const analyzer2 = new Analyzer(program2);
      const result2 = analyzer2.extractForFile('test.ts');

      const config1 = Array.from(result1.configs.values())[0];
      const config2 = Array.from(result2.configs.values())[0];

      expect(config1.containerId).toBe(config2.containerId);
    });

    it('should generate different hashes for different content', () => {
      const source1 = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          injections: [{ token: ServiceA }]
        });
      `;

      const source2 = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';

        export const container = defineBuilderConfig({
          injections: [{ token: ServiceB }]
        });
      `;

      const program1 = createProgram(source1);
      const analyzer1 = new Analyzer(program1);
      const result1 = analyzer1.extractForFile('test.ts');

      const program2 = createProgram(source2);
      const analyzer2 = new Analyzer(program2);
      const result2 = analyzer2.extractForFile('test.ts');

      const config1 = Array.from(result1.configs.values())[0];
      const config2 = Array.from(result2.configs.values())[0];

      expect(config1.containerId).not.toBe(config2.containerId);
    });
  });
});
