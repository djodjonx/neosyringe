import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import type { ProgramTransformerExtras } from 'ts-patch';
import { ConfigCollector } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import neoSyringeTransformer from '../src/transformer';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const extras: ProgramTransformerExtras = { ts };

const PLAIN = 'export const answer = 42;\nexport function add(a: number, b: number): number { return a + b; }\n';

const CONTAINER = [
  "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
  'export class Dep {}',
  'export const container = defineBuilderConfig({ name: "GateContainer", injections: [{ token: Dep }] });',
  '',
].join('\n');

// No NeoSyringe import, only a call that reads like a resolve call.
const CALLER = 'declare const box: { resolve<T>(token: T): T };\nexport const value = box.resolve(1);\n';

let dir = '';
let previousCwd = '';

beforeAll(() => {
  previousCwd = process.cwd();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't03c1-gate-')));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
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
  }));
  writeFileSync(path.join(dir, 'plain.ts'), PLAIN);
  writeFileSync(path.join(dir, 'container.ts'), CONTAINER);
  writeFileSync(path.join(dir, 'caller.ts'), CALLER);
  process.chdir(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  TSContext.reset();
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

function programOf(...files: string[]): ts.Program {
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, path.join(dir, 'tsconfig.json'));
  return ts.createProgram(files.map((file) => path.join(dir, file)), parsed.options);
}

/**
 * There is no public counter of collections (the product code gets no stats field), so the collection
 * is observed on the collector itself. The spy calls through: the real analysis still runs.
 */
function collections(run: () => void): number {
  const spy = vi.spyOn(ConfigCollector.prototype, 'collectAll');
  run();
  return spy.mock.calls.length;
}

describe('T03 C1 the transformer analyses a program only when a file can reach NeoSyringe', () => {
  it('W13 a program with no marker and no resolve call is not analysed and is returned as it came', () => {
    const program = programOf('plain.ts');
    let returned: ts.Program | undefined;
    const count = collections(() => {
      returned = neoSyringeTransformer(program, undefined, {}, extras);
    });
    expect(count).toBe(0);
    expect(returned).toBe(program);
  });

  it('W13 a program whose only hint is a resolve call is analysed (control)', () => {
    const count = collections(() => {
      neoSyringeTransformer(programOf('plain.ts', 'caller.ts'), undefined, {}, extras);
    });
    expect(count).toBeGreaterThan(0);
  });

  it('W13 a program with a container is analysed (control)', () => {
    const count = collections(() => {
      neoSyringeTransformer(programOf('plain.ts', 'container.ts'), undefined, {}, extras);
    });
    expect(count).toBeGreaterThan(0);
  });
});
