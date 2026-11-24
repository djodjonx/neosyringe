import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { resolveProjectConfig } from '../../src/resolveProjectConfig';
import { TSContext } from '../../src/TSContext';
import { createFastProgram, warmLibCache } from '../fastProgram';

const here = path.dirname(fileURLToPath(import.meta.url));
const neosyringeEntry = path.resolve(here, '../../../neosyringe/src/index.ts');
const scratch: string[] = [];

const APP = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { ConsoleLogger } from './logger';

export const app = defineBuilderConfig({
  name: 'App',
  injections: [{ token: ConsoleLogger }],
});
`;

const LOGGER = `
export class ConsoleLogger {
  line(): string { return 'log'; }
}
`;

function writeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-root-'));
  scratch.push(root);
  const src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      rootDir: 'src',
      baseUrl: '.',
      skipLibCheck: true,
      lib: ['ES5'],
      types: [],
      paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
    },
    include: ['src'],
  }));
  writeFileSync(path.join(src, 'logger.ts'), LOGGER);
  writeFileSync(path.join(src, 'app.ts'), APP);
  return root;
}

function containerGraph(root: string): DependencyGraph {
  const resolved = resolveProjectConfig(root);
  const program = createFastProgram(resolved.fileNames, resolved.options);
  const graphs = new Analyzer(program).extractAll();
  const graph = graphs.find((item) => (item.sourceFileName ?? '').endsWith('/src/app.ts'));
  if (!graph) throw new Error('missing container graph');
  return graph;
}

function emit(root: string): { reference: string; optimized: string; separate: string } {
  const src = path.join(root, 'src');
  return TSContext.runWithProjectRoot(root, () => {
    const graph = containerGraph(root);
    return {
      reference: new Generator(graph, true, src, false, false, 'reference').generate(),
      optimized: new Generator(graph, true, src, false, false, 'optimized').generate(),
      separate: new Generator(graph, false, src, false, false, 'reference').generate(),
    };
  });
}

describe('T10 two roots', () => {
  afterEach(() => {
    TSContext.reset();
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T10-I1 two roots equal JS', () => {
    warmLibCache();
    const leftRoot = writeRoot();
    const rightRoot = writeRoot();
    const left = emit(leftRoot);
    const right = emit(rightRoot);
    expect(left.reference).toBe(right.reference);
    expect(left.optimized).toBe(right.optimized);
    expect(left.separate).toBe(right.separate);
    expect(left.reference).not.toContain(leftRoot);
    expect(left.optimized).not.toContain(leftRoot);
    expect(left.separate).not.toContain(leftRoot);
  });
});
