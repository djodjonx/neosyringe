import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { dumpGraph } from '../../core/tests/helpers/t03c1-dump';
import { graphsForProgram } from '../src/analysisCache';
import { neoSyringePlugin } from '../src/index';
import { sessionStateKey, type SessionState } from '../src/session';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SOURCE = [
  "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
  'export interface IPort { id: number }',
  'export const c = defineBuilderConfig({',
  '  injections: [',
  '    { token: useInterface<IPort>(), useFactory: true, dependencies: [], provider: () => useInterface<IPort>() as IPort },',
  '  ],',
  '});',
  '',
].join('\n');

let dir = '';
let previousCwd = '';

beforeAll(() => {
  previousCwd = process.cwd();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't03c1-p9-')));
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
  writeFileSync(path.join(dir, 'app.ts'), SOURCE);
  process.chdir(dir);
});

afterEach(() => {
  TSContext.reset();
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

function programOf(): ts.Program {
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, path.join(dir, 'tsconfig.json'));
  return ts.createProgram([path.join(dir, 'app.ts')], parsed.options);
}

function blankState(): SessionState {
  return {
    registeredTokens: new Set(),
    usedTokens: new Map(),
    generatedContainerVars: new Set(),
    devtoolsGraphs: new Map(),
    cachedSources: new Map(),
    filesParsed: 0,
    graphsBuilt: 0,
    declarationSources: new Map(),
  };
}

function isSessionState(value: unknown): value is SessionState {
  return typeof value === 'object' && value !== null && 'registeredTokens' in value && 'cachedSources' in value;
}

/** The state a plugin keeps for its session, read under the key the session module names. */
function sessionOf(plugin: object): SessionState | undefined {
  const value: unknown = Reflect.get(plugin, sessionStateKey);
  return isSessionState(value) ? value : undefined;
}

function hasCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';
}

describe('T03 C1 a consumer that writes into a graph never writes into the shared snapshot', () => {
  it('P9 graphs returned without a host program are copies of the snapshot graphs', () => {
    const program = programOf();
    const before = new Analyzer(program).extractAll().map(dumpGraph);
    expect(before).toHaveLength(1);

    const state = blankState();
    const graphs = graphsForProgram(state, () => new Analyzer(program).extractAll(), undefined);
    const shared = new Analyzer(program).extractAll();
    expect(graphs[0]).not.toBe(shared[0]);

    // What a consumer does when it writes into a registration. The plugin writes `factoryRewrites` and
    // `valueRewrites` there (attachRewrites), never into the snapshot.
    for (const graph of graphs) {
      for (const node of graph.nodes.values()) node.service.factorySource = '() => "REWRITTEN"';
    }
    expect(new Analyzer(program).extractAll().map(dumpGraph)).toEqual(before);
  });

  it('P9 a plugin transform leaves the snapshot graphs of its program as the analyzer built them', () => {
    const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json' });
    if (Array.isArray(plugin) || typeof plugin.transform !== 'function') throw new Error('hook transform attendu');
    const transform = plugin.transform as (code: string, id: string) => unknown;
    const output = transform(SOURCE, path.join(dir, 'app.ts'));
    const code = typeof output === 'string' ? output : hasCode(output) ? output.code : '';
    expect(code).toContain('() => "IPort_');

    const program = sessionOf(plugin)?.previousProgram;
    if (!program) throw new Error('the session keeps no program');
    const graphs = new Analyzer(program).extractAll();
    expect(graphs).toHaveLength(1);
    const services = [...(graphs[0]?.nodes.values() ?? [])].map((node) => node.service);
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      // The transform rewrote the marker (see the code above), and carried that on its own copy of the graph.
      expect(service.factoryRewrites).toBeUndefined();
      expect(service.valueRewrites).toBeUndefined();
      expect(service.factorySource).toContain('useInterface<IPort>');
    }
  });
});
