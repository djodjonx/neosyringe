import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

/**
 * Type validation tests for useProperty<T> + factory provider.
 *
 * Bug: useProperty<number>(...) with provider: () => 'a string' produced no TypeScript
 * error. The InjectionParser detected the useProperty call and set useFactory=true but
 * never validated that the factory's return type is assignable to T.
 */
describe('useProperty<T> provider type validation', () => {
  function createProgram(code: string): ts.Program {
    const fileName = 'test.ts';
    const host = ts.createCompilerHost({});
    const orig = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lv) =>
      name === fileName ? ts.createSourceFile(fileName, code, lv, true) : orig(name, lv);
    host.fileExists = (f) => f === fileName || ts.sys.fileExists(f);
    host.readFile = (f) => (f === fileName ? code : ts.sys.readFile(f));
    return ts.createProgram([fileName], {}, host);
  }

  // ── Failing cases (must produce type-mismatch error) ────────────────────────

  it('errors when provider returns string but useProperty<number> expects number', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Login { constructor(public tokenExpired: number) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<number>(Login, 'tokenExpired'), provider: () => 'env.TOKEN_EXPIRATION' }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const errors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('number');
    expect(errors[0].message).toContain('string');
  });

  it('errors when provider returns number but useProperty<string> expects string', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public url: string) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<string>(Service, 'url'), provider: () => 42 }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const errors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('string');
    expect(errors[0].message).toContain('number');
  });

  it('errors when provider returns boolean but useProperty<number> expects number', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public maxRetries: number) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<number>(Service, 'maxRetries'), provider: () => true }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const errors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(errors.length).toBeGreaterThan(0);
  });

  it('errors when provider returns object but useProperty<string> expects string', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public name: string) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<string>(Service, 'name'), provider: () => ({ value: 'test' }) }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const errors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(errors.length).toBeGreaterThan(0);
  });

  // ── Passing cases (must NOT produce type-mismatch errors) ───────────────────

  it('accepts provider returning number for useProperty<number>', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Login { constructor(public tokenExpired: number) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<number>(Login, 'tokenExpired'), provider: () => 3600 }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(typeErrors.length).toBe(0);
  });

  it('accepts provider returning string for useProperty<string>', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public url: string) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<string>(Service, 'url'), provider: () => 'http://localhost' }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(typeErrors.length).toBe(0);
  });

  it('accepts provider returning boolean for useProperty<boolean>', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public enabled: boolean) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<boolean>(Service, 'enabled'), provider: () => true }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(typeErrors.length).toBe(0);
  });

  it('accepts provider via variable reference returning correct type', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public port: number) {} }
      const portFactory = (): number => 8080;

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<number>(Service, 'port'), provider: portFactory }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(typeErrors.length).toBe(0);
  });

  it('accepts provider returning subtype (string literal) for useProperty<string>', () => {
    // string literals are assignable to string
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Service { constructor(public env: string) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<string>(Service, 'env'), provider: () => 'production' as const }
        ]
      });
    `;

    const graph = new Analyzer(createProgram(code)).extract();
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') ?? [];

    expect(typeErrors.length).toBe(0);
  });

  // ── LSP/modular path (extractForFile) ───────────────────────────────────────

  it('also reports the error via the modular LSP path (extractForFile)', () => {
    const code = `
      function defineBuilderConfig(c: any) { return c; }
      function useProperty<T>(cls: any, name: string): any { return null; }
      class Login { constructor(public tokenExpired: number) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useProperty<number>(Login, 'tokenExpired'), provider: () => 'env.TOKEN_EXPIRATION' }
        ]
      });
    `;

    const program = createProgram(code);
    const result = new Analyzer(program).extractForFile('test.ts');

    const errors = result.errors.filter(e => e.type === 'type-mismatch');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('number');
    expect(errors[0].message).toContain('string');
  });
});
