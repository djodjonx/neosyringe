import { describe, it, expect, afterEach } from 'vitest';
import * as ts from 'typescript';
import * as path from 'node:path';
import type { PluginConfig } from 'ts-patch';
import neoSyringeTransformer from '../src/transformer';

/**
 * Real (unmocked) integration test for the ts-patch transformer path — proves
 * the `debug` option (read from the plugin's own tsconfig.json entry) behaves
 * identically to the bundler plugin (see debugOption.test.ts), since both
 * share the same resolveDebugFlag from @djodjonx/neosyringe-core.
 *
 * Uses a real file on disk (not an in-memory host): the transformer creates
 * its own per-file sub-program internally via a *default* compiler host
 * (`tsInstance.createProgram([fileName], compilerOptions)`, with no host
 * override), which reads from the real filesystem — exactly what happens in
 * real ts-patch usage against a real project.
 */
describe('neoSyringeTransformer — debug option (real, unmocked)', () => {
  const FILE = path.join(__dirname, '__fixtures__', 'debug-option', 'container.ts');

  function transformedText(config: PluginConfig): string {
    const program = ts.createProgram([FILE], {});
    const result = neoSyringeTransformer(program, undefined, config, { ts });
    return result.getSourceFile(FILE)!.text;
  }

  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('strips the data by default outside production (opt-in, not opt-out)', () => {
    process.env.NODE_ENV = 'test';
    const text = transformedText({ transform: '@djodjonx/neosyringe-plugin/transformer' });
    expect(text).toContain('public get _graph() { return []; }');
    expect(text).not.toContain('"dependencies"');
  });

  it('{ debug: false } in tsconfig.json strips the data outside production (same as the default)', () => {
    process.env.NODE_ENV = 'test';
    const text = transformedText({ transform: '@djodjonx/neosyringe-plugin/transformer', debug: false });
    expect(text).toContain('public get _graph() { return []; }');
    expect(text).not.toContain('"dependencies"');
  });

  it('{ debug: true } in tsconfig.json embeds real debug data outside production', () => {
    process.env.NODE_ENV = 'test';
    const text = transformedText({ transform: '@djodjonx/neosyringe-plugin/transformer', debug: true });
    expect(text).toContain('"dependencies"');
  });

  it('NODE_ENV=production forces stripping even with { debug: true }', () => {
    process.env.NODE_ENV = 'production';
    const text = transformedText({ transform: '@djodjonx/neosyringe-plugin/transformer', debug: true });
    expect(text).toContain('public get _graph() { return []; }');
    expect(text).not.toContain('"dependencies"');
  });
});
