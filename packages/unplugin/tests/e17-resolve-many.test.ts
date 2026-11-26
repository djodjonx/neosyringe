import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';

/**
 * E17 `resolveMany` in the plugin. A file whose only resolution call is `resolveMany` still reaches the usage check at
 * the end of the build, and each token of a literal list is reported at its own position.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];

afterEach(() => {
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type PluginHooks = {
  transform: (code: string, id: string) => unknown;
  buildEnd: () => void;
};

function hooks(validation?: 'strict' | 'compatible'): PluginHooks {
  const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json', validation });
  if (Array.isArray(plugin) || typeof plugin.transform !== 'function' || typeof plugin.buildEnd !== 'function') {
    throw new Error('transform and buildEnd hooks expected');
  }
  return plugin as PluginHooks;
}

function writeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e17-'));
  dirs.push(dir);
  const config = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib: ['ES2020'],
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  };
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

function thrownMessage(buildEnd: () => void): string {
  try {
    buildEnd();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const TOKENS = `
  export interface IFoo { id: number }
  export interface IBar { id: number }
`;

const CONTAINER = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IBar } from './tokens';
  class BarImpl implements IBar { id = 2 }
  export const containerB = defineBuilderConfig({
    injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
  });
`;

/** Only resolveMany calls, no other resolution text. */
const CONSUMER = `
  import { useInterface } from '@djodjonx/neosyringe';
  import { containerB } from './container';
  import { IFoo, IBar } from './tokens';
  containerB.resolveMany([useInterface<IBar>(), useInterface<IFoo>()]);
`;

/**
 * Class tokens only: no NeoSyringe import. The consumer still has value imports, and `hasNeoSyringeMarkers` takes any
 * value import for a marker (markerUtils.ts:29-41), so this scenario does not depend on `textCallsResolve`.
 */
const CLASS_TOKENS = `
  export class BarSvc {}
  export class FooSvc {}
`;

const CLASS_CONTAINER = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';
  import { BarSvc } from './class-tokens';
  export const containerC = defineBuilderConfig({ injections: [BarSvc] });
`;

const CLASS_CONSUMER = `
  import { containerC } from './class-container';
  import { BarSvc, FooSvc } from './class-tokens';
  containerC.resolveMany([BarSvc, FooSvc]);
`;

/**
 * No value import and no marker call: `import type` is not a marker (markerUtils.ts:29-31), so `hasNeoSyringeMarkers` is
 * false and only `textCallsResolve` can put this file in the check. The receiver is typed `Container`, so the analyzer
 * reports it as an unknown container at the call.
 */
const TYPE_ONLY_CONSUMER = `
  import type { Container } from '@djodjonx/neosyringe';
  export function load(container: Container): void {
    container.resolveMany([]);
  }
`;

const DYNAMIC = `
  import { useInterface } from '@djodjonx/neosyringe';
  import { containerB } from './container';
  import { IFoo } from './tokens';
  const list = [useInterface<IFoo>()];
  containerB.resolveMany(list);
`;

const HOMONYM = `
  import { useInterface } from '@djodjonx/neosyringe';
  import { IFoo } from './tokens';
  const bag = { resolveMany(tokens: unknown[]): unknown[] { return tokens; } };
  bag.resolveMany([useInterface<IFoo>()]);
`;

/** `line:column` (1-based) of `needle` in `text`. */
function positionOf(text: string, needle: string): string {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`no ${needle} in the source`);
  const before = text.slice(0, index).split('\n');
  return `${before.length}:${(before[before.length - 1] ?? '').length + 1}`;
}

function run(files: Record<string, string>, sources: Record<string, string>, validation?: 'strict' | 'compatible') {
  const dir = writeProject(files);
  const previous = process.cwd();
  process.chdir(dir);
  const warned: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => { warned.push(parts.map(String).join(' ')); });
  try {
    const plugin = hooks(validation);
    for (const [name, text] of Object.entries(sources)) plugin.transform(text, path.join(dir, name));
    return { dir, message: thrownMessage(plugin.buildEnd), warned: warned.join('\n') };
  } finally {
    warn.mockRestore();
    process.chdir(previous);
  }
}

describe('E17-P11 resolveMany in the plugin', () => {
  it('E17-P11 a resolveMany-only consumer file fails the build at the position of the missing element', () => {
    const { dir, message } = run(
      { 'tokens.ts': TOKENS, 'container.ts': CONTAINER, 'consumer.ts': CONSUMER },
      { 'container.ts': CONTAINER, 'consumer.ts': CONSUMER },
    );
    const position = positionOf(CONSUMER, 'useInterface<IFoo>()]');
    expect(message).toContain(`NEO_MISSING_PROVIDER: 'IFoo' is not in container`);
    expect(message).toContain(` at ${path.join(dir, 'consumer.ts')}:${position}`);
    expect(message).not.toContain("'IBar' is not in container");
  });

  it('E17-P11 a list that is not literal is an error in the strict mode', () => {
    const { dir, message } = run(
      { 'tokens.ts': TOKENS, 'container.ts': CONTAINER, 'consumer.ts': DYNAMIC },
      { 'container.ts': CONTAINER, 'consumer.ts': DYNAMIC },
      'strict',
    );
    expect(message).toContain('NEO_UNKNOWN_CONTAINER: resolveMany tokens are not a literal list');
    expect(message).toContain(` at ${path.join(dir, 'consumer.ts')}:${positionOf(DYNAMIC, 'list);')}`);
    expect(message).not.toContain('NEO_MISSING_PROVIDER');
  });

  it('E17-P11 a list that is not literal is a warning in the compatible mode', () => {
    const { dir, message, warned } = run(
      { 'tokens.ts': TOKENS, 'container.ts': CONTAINER, 'consumer.ts': DYNAMIC },
      { 'container.ts': CONTAINER, 'consumer.ts': DYNAMIC },
      'compatible',
    );
    expect(message).toBe('');
    expect(warned).toContain('NEO_UNKNOWN_CONTAINER: resolveMany tokens are not a literal list');
    expect(warned).toContain(` at ${path.join(dir, 'consumer.ts')}:${positionOf(DYNAMIC, 'list);')}`);
  });

  it('E17-P11 an object that only has a resolveMany method is not a usage, a real call beside it is', () => {
    const files = { 'tokens.ts': TOKENS, 'container.ts': CONTAINER, 'consumer.ts': HOMONYM, 'real.ts': CONSUMER };
    const { dir, message } = run(files, { 'container.ts': CONTAINER, 'consumer.ts': HOMONYM, 'real.ts': CONSUMER });
    expect(message).toContain(` at ${path.join(dir, 'real.ts')}:${positionOf(CONSUMER, 'useInterface<IFoo>()]')}`);
    expect(message).not.toContain(path.join(dir, 'consumer.ts'));
  });

  it('E17-P11 a consumer with no NeoSyringe import and only a resolveMany call still fails the build', () => {
    const { dir, message } = run(
      { 'class-tokens.ts': CLASS_TOKENS, 'class-container.ts': CLASS_CONTAINER, 'class-consumer.ts': CLASS_CONSUMER },
      { 'class-container.ts': CLASS_CONTAINER, 'class-consumer.ts': CLASS_CONSUMER },
    );
    expect(message).toContain(`NEO_MISSING_PROVIDER: 'FooSvc' is not in container`);
    expect(message).toContain(` at ${path.join(dir, 'class-consumer.ts')}:${positionOf(CLASS_CONSUMER, 'FooSvc])')}`);
  });

  it('E17-P11 a file whose only NeoSyringe trace is a resolveMany call is still in the check', () => {
    // The container file runs a compilation session, so buildEnd compiles with the tsconfig options and resolves the type.
    const { dir, message } = run(
      { 'tokens.ts': TOKENS, 'container.ts': CONTAINER, 'type-only.ts': TYPE_ONLY_CONSUMER },
      { 'container.ts': CONTAINER, 'type-only.ts': TYPE_ONLY_CONSUMER },
    );
    expect(message).toContain('NEO_UNKNOWN_CONTAINER: resolve receiver is not a known container');
    expect(message).toContain(` at ${path.join(dir, 'type-only.ts')}:${positionOf(TYPE_ONLY_CONSUMER, 'container.resolveMany')}`);
  });
});
