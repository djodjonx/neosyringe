import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

/**
 * Tests for definePartialConfig `expects` field.
 *
 * The `expects` field declares tokens a partial requires from its host container.
 * - Partial validation: expected tokens count as available → no false-positive errors.
 * - Builder validation: builder must provide all tokens declared in partial's `expects`.
 */
describe('definePartialConfig — expects field', () => {
  function createProgram(files: Record<string, string>): ts.Program {
    const host = ts.createCompilerHost({});
    const orig = host.getSourceFile.bind(host);
    host.getSourceFile = (name, v) => {
      const key = Object.keys(files).find(k => name.endsWith(k.replace('./', '')));
      if (key) return ts.createSourceFile(name, files[key], v, true);
      return orig(name, v);
    };
    host.fileExists = (f) =>
      Object.keys(files).some(k => f.endsWith(k.replace('./', ''))) || ts.sys.fileExists(f);
    return ts.createProgram(Object.keys(files), {}, host);
  }

  // ── Phase 1: false-positive suppression ─────────────────────────────────────

  it('suppresses missing-dep errors for tokens declared in expects (interface token)', () => {
    const code = `
      function definePartialConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICacheClient { get(k: string): string; }
      class Login { constructor(private cache: ICacheClient) {} }

      export const userPartial = definePartialConfig({
        expects: [useInterface<ICacheClient>()],
        injections: [{ token: Login }]
      });
    `;
    const graph = new Analyzer(createProgram({ 'partial.ts': code })).extract();
    const missingErrors = graph.errors?.filter(e => e.type === 'missing') ?? [];
    expect(missingErrors).toHaveLength(0);
  });

  it('still errors on deps that are missing AND not in expects', () => {
    const code = `
      function definePartialConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICacheClient { get(k: string): string; }
      interface ITokenService { verify(t: string): boolean; }
      class Login {
        constructor(private cache: ICacheClient, private token: ITokenService) {}
      }

      export const userPartial = definePartialConfig({
        expects: [useInterface<ICacheClient>()],
        injections: [{ token: Login }]
      });
    `;
    const program = createProgram({ 'partial.ts': code });
    const result = new Analyzer(program).extractForFile('partial.ts');
    const missingErrors = result.errors.filter(e => e.type === 'missing');
    expect(missingErrors).toHaveLength(1);
    expect(missingErrors[0].message).toContain('ITokenService');
  });

  it('still errors on missing deps when expects is absent (regression)', () => {
    const code = `
      function definePartialConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICacheClient { get(k: string): string; }
      class Login { constructor(private cache: ICacheClient) {} }

      export const userPartial = definePartialConfig({
        injections: [{ token: Login }]
      });
    `;
    const program = createProgram({ 'partial.ts': code });
    const result = new Analyzer(program).extractForFile('partial.ts');
    const missingErrors = result.errors.filter(e => e.type === 'missing');
    expect(missingErrors).toHaveLength(1);
    expect(missingErrors[0].message).toContain('ICacheClient');
  });

  it('supports class tokens in expects', () => {
    const code = `
      function definePartialConfig(c: any) { return c; }
      class CacheClient {}
      class Login { constructor(private cache: CacheClient) {} }

      export const userPartial = definePartialConfig({
        expects: [CacheClient],
        injections: [{ token: Login }]
      });
    `;
    const graph = new Analyzer(createProgram({ 'partial.ts': code })).extract();
    const missingErrors = graph.errors?.filter(e => e.type === 'missing') ?? [];
    expect(missingErrors).toHaveLength(0);
  });

  it('suppresses errors via the LSP modular path (extractForFile)', () => {
    const code = `
      function definePartialConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICacheClient { get(k: string): string; }
      class Login { constructor(private cache: ICacheClient) {} }

      export const userPartial = definePartialConfig({
        expects: [useInterface<ICacheClient>()],
        injections: [{ token: Login }]
      });
    `;
    const program = createProgram({ 'partial.ts': code });
    const result = new Analyzer(program).extractForFile('partial.ts');
    const missingErrors = result.errors.filter(e => e.type === 'missing');
    expect(missingErrors).toHaveLength(0);
  });

  // ── Phase 2: assembly-level validation ──────────────────────────────────────

  it('builder passes when it provides all tokens declared in partial expects', () => {
    const files = {
      'partial.ts': `
        function definePartialConfig(c: any) { return c; }
        function useInterface<T>(): any { return null; }
        interface ICacheClient { get(k: string): string; }
        class Login { constructor(private cache: ICacheClient) {} }
        export const userPartial = definePartialConfig({
          expects: [useInterface<ICacheClient>()],
          injections: [{ token: Login }]
        });
      `,
      'container.ts': `
        import { userPartial } from './partial';
        function defineBuilderConfig(c: any) { return c; }
        function useInterface<T>(): any { return null; }
        interface ICacheClient { get(k: string): string; }
        class RedisCacheClient implements ICacheClient { get(k: string) { return ''; } }
        export const appContainer = defineBuilderConfig({
          extends: [userPartial],
          injections: [
            { token: useInterface<ICacheClient>(), provider: RedisCacheClient }
          ]
        });
      `,
    };
    const missingErrors = new Analyzer(createProgram(files)).extractAllErrors().filter(e => e.type === 'missing');
    expect(missingErrors).toHaveLength(0);
  });

  it('builder errors when it does NOT provide a token declared in partial expects', () => {
    const files = {
      'partial.ts': `
        function definePartialConfig(c: any) { return c; }
        function useInterface<T>(): any { return null; }
        interface ICacheClient { get(k: string): string; }
        class Login { constructor(private cache: ICacheClient) {} }
        export const userPartial = definePartialConfig({
          expects: [useInterface<ICacheClient>()],
          injections: [{ token: Login }]
        });
      `,
      'container.ts': `
        import { userPartial } from './partial';
        function defineBuilderConfig(c: any) { return c; }
        export const appContainer = defineBuilderConfig({
          extends: [userPartial],
          injections: []
        });
      `,
    };
    const missingErrors = new Analyzer(createProgram(files)).extractAllErrors().filter(e => e.type === 'missing');
    expect(missingErrors.length).toBeGreaterThan(0);
    expect(missingErrors.some(e => e.message.includes('ICacheClient'))).toBe(true);
  });

  it('builder passes Phase 2 when expects token is satisfied via another extended partial', () => {
    // The builder doesn't inject ICacheClient directly — it extends a partial that provides it.
    // That inherited token should satisfy the user partial's expects.
    const files = {
      'cache-partial.ts': `
        function definePartialConfig(c: any) { return c; }
        function useInterface<T>(): any { return null; }
        interface ICacheClient { get(k: string): string; }
        class RedisCacheClient implements ICacheClient { get(k: string) { return ''; } }
        export const cachePartial = definePartialConfig({
          injections: [{ token: useInterface<ICacheClient>(), provider: RedisCacheClient }]
        });
      `,
      'user-partial.ts': `
        function definePartialConfig(c: any) { return c; }
        function useInterface<T>(): any { return null; }
        interface ICacheClient { get(k: string): string; }
        class Login { constructor(private cache: ICacheClient) {} }
        export const userPartial = definePartialConfig({
          expects: [useInterface<ICacheClient>()],
          injections: [{ token: Login }]
        });
      `,
      'container.ts': `
        import { cachePartial } from './cache-partial';
        import { userPartial } from './user-partial';
        function defineBuilderConfig(c: any) { return c; }
        export const appContainer = defineBuilderConfig({
          extends: [cachePartial, userPartial],
          injections: []
        });
      `,
    };
    const program = createProgram(files);
    const errors = new Analyzer(program).extractAllErrors();
    const missingErrors = errors.filter(e => e.type === 'missing');
    expect(missingErrors).toHaveLength(0);
  });
});
