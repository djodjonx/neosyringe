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
    it('generates a namespace import and uses Import_N.default for default exports', () => {
      // For default exports, the generator emits `import * as Import_0 from './...'` and
      // uses `Import_0.default` instead of the local alias `Login`.
      // This is bundler-safe: an explicit import declaration is always correctly tracked,
      // whereas local alias references can be silently dropped or not renamed by rolldown
      // when it inlines modules after the neosyringe transform has already injected code.
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
      expect(code).not.toContain('__neo_');
      // Self-contained namespace import — no dependency on local alias in scope
      expect(code).toContain('import * as Import_');
      expect(code).toContain('Import_0.default');
    });

    it('uses Import_N.default when alias differs from class name (no scope dependency)', () => {
      // Critical regression: `import Login from './auth-service'` where class is AuthService.
      // Must never generate `new AuthService()` (not in scope) or `new Login()` (local alias
      // that bundlers may silently drop). Must use Import_N.default.
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
      expect(code).not.toContain('__neo_');
      expect(code).toContain('import * as Import_');
      expect(code).toContain('Import_0.default');
    });

    it('uses Import_N.default in token comparison', () => {
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

      expect(code).toContain('Import_0.default');
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

      expect(code).not.toContain('__neo_');
      expect(code).not.toContain('Import_');
      expect(code).toContain('new AuthService(');
    });
  });
});
