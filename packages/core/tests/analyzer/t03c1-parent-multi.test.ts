import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ConfigCollector } from '../../src/analyzer/collectors/ConfigCollector';
import { TokenResolver } from '../../src/analyzer/resolvers/TokenResolver';
import { createVirtualProgram } from '../helpers/createVirtualProgram';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FILE = captureRoot('multi.ts');

const HEADER = [
  "import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
  'interface Plugin { name: string }',
  'interface Secret { name: string }',
  'interface Summary { names: string[] }',
  'const plugin = useInterface<Plugin>();',
  'const secret = useInterface<Secret>();',
  'const summary = useInterface<Summary>();',
].join('\n');

const PLUGINS = [
  "  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },",
  "  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },",
].join('\n');

function summaryOf(token: string): string {
  return [
    '  {',
    '    token: summary,',
    '    useFactory: true,',
    `    dependencies: [{ all: ${token} }],`,
    `    provider: (context): Summary => ({ names: context.resolveAll(${token}).map((item) => item.name) }),`,
    '  },',
  ].join('\n');
}

/** A fixture is one file. Each scenario names the container that must be clean or refused. */
function fixture(...blocks: string[]): ReadonlyMap<string, string> {
  return new Map([[FILE, `${HEADER}\n${blocks.join('\n')}\n`]]);
}

const OPEN_PARENT = fixture(
  `export const parent = defineBuilderConfig({ name: 'OpenParent', injections: [\n${PLUGINS}\n] });`,
  `export const child = defineBuilderConfig({ name: 'OpenChild', useContainer: parent, injections: [\n${summaryOf('plugin')}\n] });`,
);

const CLOSED_EXPORTED = fixture(
  `export const parent = defineBuilderConfig({ name: 'ClosedParent', optimization: { mode: 'closed', roots: [{ all: plugin }] }, injections: [\n${PLUGINS}\n] });`,
  `export const child = defineBuilderConfig({ name: 'ClosedChild', useContainer: parent, injections: [\n${summaryOf('plugin')}\n] });`,
);

const CLOSED_PRIVATE = fixture(
  `export const parent = defineBuilderConfig({ name: 'PrivateParent', optimization: { mode: 'closed', roots: [{ all: plugin }] }, injections: [\n${PLUGINS}\n` +
    "  { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },\n] });",
  `export const child = defineBuilderConfig({ name: 'PrivateChild', useContainer: parent, injections: [\n${summaryOf('secret')}\n] });`,
);

const GRANDPARENT = fixture(
  `export const grand = defineBuilderConfig({ name: 'Grand', injections: [\n${PLUGINS}\n] });`,
  "export const parent = defineBuilderConfig({ name: 'Middle', useContainer: grand, injections: [] });",
  `export const child = defineBuilderConfig({ name: 'Leaf', useContainer: parent, injections: [\n${summaryOf('plugin')}\n] });`,
);

const CLOSED_MIDDLE = fixture(
  `export const grand = defineBuilderConfig({ name: 'Grand', injections: [\n${PLUGINS}\n] });`,
  "export const middle = defineBuilderConfig({ name: 'Middle', useContainer: grand, optimization: { mode: 'closed', roots: [{ all: secret }] }, injections: [\n" +
    "  { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },\n] });",
  `export const child = defineBuilderConfig({ name: 'Leaf', useContainer: middle, injections: [\n${summaryOf('plugin')}\n] });`,
);

const EXTENDED_PARTIAL = fixture(
  `export const part = definePartialConfig({ injections: [\n${PLUGINS}\n] });`,
  `export const host = defineBuilderConfig({ name: 'Host', extends: [part], injections: [\n${summaryOf('plugin')}\n] });`,
);

const GHOST = fixture(
  "export const parent = defineBuilderConfig({ name: 'EmptyParent', injections: [] });",
  `export const child = defineBuilderConfig({ name: 'MissingChild', useContainer: parent, injections: [\n${summaryOf('plugin')}\n] });`,
);

function codesOf(files: ReadonlyMap<string, string>): string[] {
  const analyzer = new Analyzer(memoryProgram(files));
  const all = analyzer.extractAllErrors().map((error) => error.code ?? error.type);
  const forFile = analyzer.extractForFile(FILE).errors.map((error) => error.code ?? error.type);
  expect(forFile).toEqual(all);
  return all;
}

describe('T03 C1 { all } reaches the multi tokens of the parent and the partials', () => {
  it('W7 an open parent that registers a multi token satisfies { all } in its child', () => {
    expect(codesOf(OPEN_PARENT)).toEqual([]);
  });

  it('W7 a closed parent satisfies { all } for a multi root it exports', () => {
    expect(codesOf(CLOSED_EXPORTED)).toEqual([]);
  });

  it('W7 a closed parent still refuses { all } for a private multi token', () => {
    const errors = new Analyzer(memoryProgram(CLOSED_PRIVATE)).extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Secret'");
  });

  it('W7 a multi token two parents up satisfies { all }', () => {
    expect(codesOf(GRANDPARENT)).toEqual([]);
  });

  it('W7 a multi token registered by an extended partial satisfies { all }', () => {
    expect(codesOf(EXTENDED_PARTIAL)).toEqual([]);
  });

  it('W7 a multi token that nobody registers is still reported once', () => {
    const errors = new Analyzer(memoryProgram(GHOST)).extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Plugin'");
  });

  it('W7 a closed parent does not hand on the multi tokens of its own parent', () => {
    const errors = new Analyzer(memoryProgram(CLOSED_MIDDLE)).extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Plugin'");
  });

  it('W7 two builders that name each other as parent give their multi tokens once, without looping', () => {
    const source = [
      HEADER,
      `export const first = defineBuilderConfig({ name: 'First', useContainer: second, injections: [\n${PLUGINS}\n] });`,
      "export const second = defineBuilderConfig({ name: 'Second', useContainer: first, injections: [",
      "  { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },",
      '] });',
      '',
    ].join('\n');
    const program = createVirtualProgram('t03c1-multi-loop.ts', source);
    const configs = new ConfigCollector(program, program.getTypeChecker()).collect();
    const first = [...configs.values()].find((config) => config.name === 'first');
    if (!first) throw new Error('missing builder first');
    const found = new TokenResolver().resolveInheritedMultiTokens(first, configs);
    expect([...found].map((id) => id.split('_')[0]).sort()).toEqual(['Plugin', 'Secret']);
  });
});
