import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import { Generator } from '../../src/generator/Generator';
import { resolveProjectConfig } from '../../src/resolveProjectConfig';
import { TSContext } from '../../src/TSContext';
import { createFastProgram, warmLibCache } from '../fastProgram';

const here = path.dirname(fileURLToPath(import.meta.url));
const neosyringeEntry = path.resolve(here, '../../../neosyringe/src/index.ts');
const scratch: string[] = [];

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function writeProject(): string {
  const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t10-homonym-')));
  const src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0' }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      rootDir: '.',
      baseUrl: '.',
      skipLibCheck: true,
      lib: ['ES5'],
      types: [],
      paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
    },
    include: ['src', 'useinterface-test.ts'],
  }));
  writeFileSync(path.join(src, 'left.ts'), 'export class Service { readonly side = \'left\'; }\n');
  writeFileSync(path.join(src, 'right.ts'), 'export class Service { readonly side = \'right\'; }\n');
  writeFileSync(path.join(src, 'app.ts'), `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Service as Left } from './left';
import { Service as Right } from './right';

export const box = defineBuilderConfig({
  name: 'Box',
  injections: [{ token: Left }, { token: Right }],
});
`);
  writeFileSync(path.join(root, 'useinterface-test.ts'), `
import { useInterface } from '@djodjonx/neosyringe';
export interface ILogger { log(message: string): void }
export const probe: ILogger = null!;
export const loggerToken = useInterface<ILogger>();
`);
  return root;
}

function load(root: string): { graph: DependencyGraph; program: ts.Program } {
  const resolved = resolveProjectConfig(root);
  const program = createFastProgram(resolved.fileNames, resolved.options);
  const graphs = new Analyzer(program).extractAll();
  const graph = graphs.find((item) => (item.sourceFileName ?? '').endsWith('/src/app.ts'));
  if (!graph) throw new Error('missing container graph');
  return { graph, program };
}

function variableType(program: ts.Program, fileName: string): ts.Type {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`missing ${fileName}`);
  const checker = program.getTypeChecker();
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'probe' && node.type) {
      found = checker.getTypeFromTypeNode(node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error('missing probe');
  return found;
}

interface Side {
  readonly side: string;
}

interface Box {
  resolve(token: unknown): Side;
}

function execute(graph: DependencyGraph, outputDir: string): { box: Box; left: new () => Side; right: new () => Side } {
  const code = new Generator(graph, false, outputDir, false, false, 'reference').generate();
  expect(code).toContain('from \'./left.ts\'');
  expect(code).toContain('from \'./right.ts\'');
  class LeftService implements Side { readonly side = 'left'; }
  class RightService implements Side { readonly side = 'right'; }
  const modules: Record<string, { Service: new () => Side }> = {
    './left.ts': { Service: LeftService },
    './right.ts': { Service: RightService },
  };
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: { box?: Box } } = { exports: {} };
  const run = new Function('module', 'exports', 'require', js) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, (id: string) => {
    const hit = modules[id];
    if (!hit) throw new Error(`missing module ${id}`);
    return hit;
  });
  const box = moduleRecord.exports.box;
  if (!box) throw new Error('generated module did not export box');
  return { box, left: LeftService, right: RightService };
}

describe('T10 homonyms', () => {
  afterEach(() => {
    TSContext.reset();
    while (scratch.length > 0) {
      const dir = scratch.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pinned public ids', () => {
    warmLibCache();
    const root = writeProject();
    const { graph, program } = TSContext.runWithProjectRoot(root, () => load(root));
    expect([...graph.nodes.keys()].sort()).toEqual(['Service_6285dcce', 'Service_fee80b4d']);
    const loggerFile = program.getSourceFiles().find((file) => file.fileName.endsWith('/useinterface-test.ts'));
    if (!loggerFile) throw new Error('missing logger file');
    const loggerId = TSContext.runWithProjectRoot(root, () => {
      return new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, loggerFile.fileName));
    });
    expect(loggerId).toBe('ILogger_0b29e614');
  });

  it('homonyms distinct', () => {
    warmLibCache();
    const root = writeProject();
    const src = path.join(root, 'src');
    const executed = TSContext.runWithProjectRoot(root, () => {
      const { graph } = load(root);
      return execute(graph, src);
    });
    const left = executed.box.resolve(executed.left);
    const right = executed.box.resolve(executed.right);
    expect(left).not.toBe(right);
    expect(left.side).toBe('left');
    expect(right.side).toBe('right');
  });
});
