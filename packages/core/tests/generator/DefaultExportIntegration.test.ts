/**
 * Integration tests for default export class code generation.
 *
 * These tests exercise the full pipeline with a real TypeScript program:
 * InjectionParser.resolveDefaultLocalName → ConfigParser → Analyzer.extract() → Generator
 *
 * They specifically guard against the regression where `export default class AuthService {}`
 * imported as `import Login from './auth-service'` would generate `new AuthService()` (the
 * class declaration name, not in scope) instead of `new Login()` (the local import alias,
 * which IS in scope in the container file).
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';

function createMultiFileProgram(files: Record<string, string>): ts.Program {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (name, v) => {
    const key = Object.keys(files).find(k => name.endsWith(k.replace('./', '')));
    if (key) return ts.createSourceFile(name, files[key], v, true);
    return orig.call(host, name, v);
  };
  host.fileExists = (f) =>
    Object.keys(files).some(k => f.endsWith(k.replace('./', ''))) || ts.sys.fileExists(f);
  return ts.createProgram(Object.keys(files), {}, host);
}

describe('DefaultExport integration (InjectionParser → Analyzer → Generator)', () => {
  describe('implementationLocalName capture', () => {
    it('captures the local import alias when class name equals the alias', () => {
      // import Login from './login' where class is also named Login
      const files = {
        'login.ts': `export default class Login {}`,
        'container.ts': `
          import Login from './login';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();

      const node = [...graph.nodes.values()].find(n =>
        n.service.implementationSymbol?.getName() === 'default'
      );
      expect(node).toBeDefined();
      expect(node!.service.implementationLocalName).toBe('Login');
      expect(node!.service.tokenLocalName).toBe('Login');
    });

    it('captures the local import alias when it differs from the class declaration name', () => {
      // The critical regression case: class is `AuthService` but imported as `Login`.
      // Old fix would use "AuthService" (not in scope); correct fix uses "Login" (in scope).
      const files = {
        'auth-service.ts': `export default class AuthService {}`,
        'container.ts': `
          import Login from './auth-service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();

      const node = [...graph.nodes.values()].find(n =>
        n.service.implementationSymbol?.getName() === 'default'
      );
      expect(node).toBeDefined();
      // Must be the import alias, NOT the class declaration name
      expect(node!.service.implementationLocalName).toBe('Login');
      expect(node!.service.implementationLocalName).not.toBe('AuthService');
    });

    it('captures local name for explicit provider: token is interface, provider is default export', () => {
      const files = {
        'auth-service.ts': `export default class AuthService {}`,
        'container.ts': `
          function useInterface<T>(): any { return null; }
          function defineBuilderConfig(c: any) { return c; }
          import Login from './auth-service';
          export const container = defineBuilderConfig({
            injections: [{ token: useInterface<any>(), provider: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();

      const node = [...graph.nodes.values()].find(n =>
        n.service.implementationSymbol?.getName() === 'default'
      );
      expect(node).toBeDefined();
      expect(node!.service.implementationLocalName).toBe('Login');
    });

    it('does NOT set implementationLocalName for named exports', () => {
      // Named exports resolve to the class symbol directly (not "default"),
      // so no local name override is needed.
      const files = {
        'auth-service.ts': `export class AuthService {}`,
        'container.ts': `
          import { AuthService } from './auth-service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: AuthService }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();

      const node = [...graph.nodes.values()][0];
      expect(node).toBeDefined();
      expect(node.service.implementationSymbol?.getName()).not.toBe('default');
      expect(node.service.implementationLocalName).toBeUndefined();
    });
  });

  describe('Generator output (useDirectSymbolNames = true)', () => {
    it('generates a prefixed namespace import (__neo_Import_N) without extension for default exports', () => {
      // Prefixed alias (__neo_Import_N) avoids collision with user identifiers in the same file.
      // Extension-stripped path (no .ts) avoids duplicate specifiers alongside the user's import.
      const files = {
        'login.ts': `export default class Login {}`,
        'container.ts': `
          import Login from './login';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();
      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('new default(');
      expect(code).not.toContain('new Login(');
      expect(code).not.toContain('import * as Import_');  // no unprefix alias in inline mode
      expect(code).toContain('import * as __neo_Import_'); // prefixed alias
      expect(code).not.toContain('.ts\'');                 // no .ts extension in specifier
      expect(code).toContain('__neo_Import_0.default');
    });

    it('uses __neo_Import_N.default when alias differs from class name (no scope dependency)', () => {
      const files = {
        'auth-service.ts': `export default class AuthService {}`,
        'container.ts': `
          import Login from './auth-service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();
      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('new AuthService(');
      expect(code).not.toContain('new Login(');
      expect(code).not.toContain('new default(');
      expect(code).not.toContain('import * as Import_');
      expect(code).toContain('import * as __neo_Import_');
      expect(code).toContain('__neo_Import_0.default');
    });

    it('uses __neo_Import_N.default in token comparison', () => {
      const files = {
        'auth-service.ts': `export default class AuthService {}`,
        'container.ts': `
          import Login from './auth-service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: Login }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();
      const code = new Generator(graph, true).generate();

      expect(code).toContain('__neo_Import_0.default');
      expect(code).not.toContain('token === Login');
      expect(code).not.toContain('token === AuthService');
      expect(code).not.toContain('token === default');
    });

    it('does NOT generate namespace imports for named exports — uses direct identifier', () => {
      // Named exports are stable: rolldown correctly renames all references to them.
      // No extra import needed.
      const files = {
        'auth-service.ts': `export class AuthService {}`,
        'container.ts': `
          import { AuthService } from './auth-service';
          function defineBuilderConfig(c: any) { return c; }
          export const container = defineBuilderConfig({
            injections: [{ token: AuthService }]
          });
        `,
      };

      const analyzer = new Analyzer(createMultiFileProgram(files));
      const graph = analyzer.extract();
      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('__neo_Import_');
      expect(code).not.toContain('Import_');
      expect(code).toContain('new AuthService(');
    });
  });
});
