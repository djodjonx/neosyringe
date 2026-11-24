import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph, DependencyNode } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { resolveProjectConfig } from '../../src/resolveProjectConfig';
import { TSContext } from '../../src/TSContext';
import { createFastProgram, warmLibCache } from '../fastProgram';

const here = path.dirname(fileURLToPath(import.meta.url));
const neosyringeDist = path.resolve(here, '../../../neosyringe/dist');
const neosyringeEntry = path.resolve(here, '../../../neosyringe/src/index.ts');
const scratch: string[] = [];

const APP = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export class Clock {
  now(): number { return 1; }
}
export interface Job { name: string }
export interface Plug { name: string }
export interface Label { text: string }
const job = useInterface<Job>();
const plug = useInterface<Plug>();
const label = useInterface<Label>();

export const app = defineBuilderConfig({
  injections: [
    { token: Clock },
    { token: job, useFactory: true, dependencies: [], provider: async () => ({ name: 'job' }) },
    { token: plug, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'a' }) },
    { token: plug, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'b' }) },
    { token: label, useValue: { text: 'app' } },
  ],
});
`;

const NODE_IMPORT = /(?:import\s+(?:[^'";]*?\s+from\s+)?|require\s*\(\s*)['"]node:/;

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

function registrationsOf(graph: DependencyGraph): DependencyNode[] {
  const nodes = [...graph.nodes.values()];
  for (const list of graph.multiNodes?.values() ?? []) nodes.push(...list);
  return nodes;
}

function containerGraph(): DependencyGraph {
  const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-browser-'));
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
  writeFileSync(path.join(src, 'app.ts'), APP);
  const resolved = resolveProjectConfig(root);
  const program = createFastProgram(resolved.fileNames, resolved.options);
  const graph = new Analyzer(program).extractAll().find((item) => (item.sourceFileName ?? '').endsWith('/src/app.ts'));
  if (!graph) throw new Error('missing container graph');
  return graph;
}

function generated(
  graph: DependencyGraph,
  profile: 'full' | 'minimal',
  mode: 'open' | 'closed',
  emitter: 'reference' | 'optimized',
): string {
  const varied: DependencyGraph = {
    ...graph,
    nodes: graph.nodes,
    multiNodes: graph.multiNodes,
    runtimeProfile: profile,
    optimizationMode: mode,
  };
  return new Generator(varied, true, undefined, false, false, emitter).generate();
}

describe('T10 browser container', () => {
  afterEach(() => {
    TSContext.reset();
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no node import', () => {
    warmLibCache();
    const graph = containerGraph();
    const nodes = registrationsOf(graph);
    expect(nodes.some((node) => node.service.type === 'autowire')).toBe(true);
    expect(nodes.some((node) => node.service.type === 'factory' && node.service.isAsync === true)).toBe(true);
    expect(nodes.some((node) => node.service.type === 'value')).toBe(true);
    expect([...(graph.multiNodes?.values() ?? [])].some((list) => list.length >= 2)).toBe(true);
    expect(path.isAbsolute(graph.sourceFileName ?? '')).toBe(true);
    const profiles = ['full', 'minimal'] as const;
    const modes = ['open', 'closed'] as const;
    const emitters = ['reference', 'optimized'] as const;
    const sources = profiles.flatMap((profile) =>
      modes.flatMap((mode) => emitters.map((emitter) => generated(graph, profile, mode, emitter))),
    );
    expect(sources).toHaveLength(8);
    for (const source of sources) expect(source).not.toMatch(NODE_IMPORT);
    const hits: string[] = [];
    for (const file of filesUnder(neosyringeDist)) {
      const text = readFileSync(file, 'utf8');
      if (NODE_IMPORT.test(text)) hits.push(path.relative(neosyringeDist, file));
    }
    expect(hits).toEqual([]);
  });
});
