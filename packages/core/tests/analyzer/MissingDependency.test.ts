import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

/**
 * Tests for missing dependency validation.
 */
describe('MissingDependencyValidator', () => {
  function createProgram(fileName: string, source: string): ts.Program {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true);
      }
      return originalGetSourceFile.call(compilerHost, name, languageVersion);
    };

    return ts.createProgram([fileName], {}, compilerHost);
  }

  describe('partialConfig', () => {
    it('should detect missing constructor dependency in partialConfig', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('Repository');
      expect(missingErrors[0].message).toContain('UserService');
    });

    it('should not error when all dependencies are present', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: Repository },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle multiple missing dependencies', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(2);
    });
  });

  describe('defineBuilder', () => {
    it('should detect missing dependency not in parent', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('Repository');
    });

    it('should resolve dependency from parent', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Repository }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should resolve dependency from extends', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const partial = definePartialConfig({
          injections: [
            { token: Repository }
          ]
        });

        export const builder = defineBuilderConfig({
          extends: [partial],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle recursive extends', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        const partial1 = definePartialConfig({
          injections: [
            { token: Repository }
          ]
        });

        const partial2 = definePartialConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          extends: [partial1, partial2],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should combine parent and extends', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Repository }
          ]
        });

        const partial = definePartialConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          extends: [partial],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('providers', () => {
    it('should check useClass provider', () => {
      const source = `
        interface IRepository {}
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IRepository>(),
              provider: { useClass: Repository }
            },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      // UserService needs Repository, but we only have IRepository
      expect(missingErrors.length).toBeGreaterThan(0);
    });

    it('should ignore useValue provider', () => {
      const source = `
        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useProperty<string>(Config, 'apiKey'),
              provider: { useValue: 'test-key' }
            }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should check useFactory provider dependencies', () => {
      const source = `
        class Repository {}

        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IUserService>(),
              provider: {
                useFactory: (repo: Repository) => new UserService(repo)
              }
            }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      // Factory dependencies are handled at runtime via container.resolve()
      // So we don't validate them statically
      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('property tokens', () => {
    it('should not report false missing dependency when primitive param is covered by a useProperty token', () => {
      const source = `
        class DatabaseService {
          constructor(private connectionString: string) {}
        }

        export const partial = definePartialConfig({
          injections: [
            {
              token: useProperty<string>(DatabaseService, 'connectionString'),
              provider: { useValue: 'postgres://localhost/db' }
            },
            { token: DatabaseService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle class with no constructor', () => {
      const source = `
        class SimpleService {}

        export const builder = defineBuilderConfig({
          injections: [
            { token: SimpleService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle constructor with no parameters', () => {
      const source = `
        class SimpleService {
          constructor() {}
        }

        export const builder = defineBuilderConfig({
          injections: [
            { token: SimpleService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should skip parameters without type annotation', () => {
      const source = `
        class UserService {
          constructor(param) {} // No type annotation
        }

        export const builder = defineBuilderConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      // No error because we can't determine the dependency type
      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('multi-registration as dependency source', () => {
    it('should NOT report missing when dep is satisfied by a multi-registration (modular path)', () => {
      const source = `
        interface IPlugin { run(): void; }
        interface IRepository { query(): void; }
        class PluginA implements IPlugin { run() {} }
        class PluginB implements IPlugin { run() {} }

        class PluginManager {
          constructor(private plugin: IPlugin) {}
        }

        class DataService {
          constructor(private repo: IRepository) {}
        }

        export const container = defineBuilderConfig({
          injections: [
            { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
            { token: useInterface<IPlugin>(), provider: PluginB, multi: true },
            { token: PluginManager },
            { token: DataService },
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors).toHaveLength(1);
      expect(missingErrors[0].context?.tokenText).toContain('IRepository');
    });
  });

  describe('imported classes (cross-file alias resolution)', () => {
    // Reproduces the bug: when a provider is imported from another file,
    // checker.getSymbolAtLocation() returns an alias symbol (ImportSpecifier).
    // ConfigCollector must resolve the alias to find the actual ClassDeclaration,
    // otherwise DependencyAnalyzer cannot traverse the constructor and detect
    // missing dependencies.
    function createMultiFileProgram(files: Record<string, string>): ts.Program {
      const host = ts.createCompilerHost({});
      const orig = host.getSourceFile;
      host.getSourceFile = (name, v) => {
        const key = Object.keys(files).find(k => name.endsWith(k.replace('./', '')));
        if (key) return ts.createSourceFile(name, files[key], v, true);
        return orig.call(host, name, v);
      };
      host.fileExists = (f) => Object.keys(files).some(k => f.endsWith(k.replace('./', ''))) || ts.sys.fileExists(f);
      return ts.createProgram(Object.keys(files), {}, host);
    }

    it('detects missing injection when provider is a named import', () => {
      // UserService is imported from another file. Its constructor depends on
      // IDatabase which is NOT registered. The LSP must detect this.
      const files: Record<string, string> = {
        'service.ts': `
          interface IDatabase { query(): void; }
          export class UserService {
            constructor(private db: IDatabase) {}
          }
        `,
        'container.ts': `
          import { UserService } from './service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: UserService }]
          });
        `,
      };

      const program = createMultiFileProgram(files);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('container.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('IDatabase');
    });

    it('detects missing injection when provider is a default import', () => {
      const files: Record<string, string> = {
        'login.ts': `
          interface ITokenService { verify(t: string): boolean; }
          export default class Login {
            constructor(private tokenService: ITokenService) {}
          }
        `,
        'container.ts': `
          import Login from './login';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const program = createMultiFileProgram(files);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('container.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('ITokenService');
    });
  });
});
