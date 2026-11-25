import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const ONE = captureRoot('one.ts');
const TWO = captureRoot('two.ts');
const CHILD = captureRoot('child.ts');

const HEADER = "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';";

function homonym(label: string): string {
  return [
    HEADER,
    `export class Service${label} {}`,
    'export const container = defineBuilderConfig({',
    `  injections: [{ token: Service${label} }],`,
    '});',
    '',
  ].join('\n');
}

describe('T03 C1 homonym builders are keyed by call, never by variable name', () => {
  it('P4 two files with the same variable name give two graphs with their own identity and positions', () => {
    const files = new Map([[ONE, homonym('One')], [TWO, homonym('Two')]]);
    const graphs = new Analyzer(memoryProgram(files)).extractAll();
    expect(graphs).toHaveLength(2);
    const [one, two] = graphs;
    expect(one?.sourceFileName).toBe(ONE);
    expect(two?.sourceFileName).toBe(TWO);
    expect(one?.containerKey).toBeDefined();
    expect(one?.containerKey).not.toBe(two?.containerKey);
    expect(one?.containerId).not.toBe(two?.containerId);
    expect(one?.exportedVariableName).toBe('container');
    expect(two?.exportedVariableName).toBe('container');
    const text = (file: string): string => files.get(file) ?? '';
    expect(one?.defineBuilderConfigStart).toBe(text(ONE).indexOf('defineBuilderConfig({'));
    expect(two?.defineBuilderConfigStart).toBe(text(TWO).indexOf('defineBuilderConfig({'));
    expect(one?.variableStatementStart).toBe(text(ONE).indexOf('export const container'));
    expect([...(one?.nodes.keys() ?? [])]).toHaveLength(1);
    expect([...(two?.nodes.keys() ?? [])]).toHaveLength(1);
    expect([...(one?.nodes.keys() ?? [])]).not.toEqual([...(two?.nodes.keys() ?? [])]);
  });

  it('P4 a child that names the second homonym as parent takes the tokens of that one', () => {
    const files = new Map([
      [ONE, homonym('One')],
      [TWO, homonym('Two')],
      [CHILD, [
        HEADER,
        "import { container } from './two';",
        'export class Child {}',
        'export const child = defineBuilderConfig({',
        '  useContainer: container,',
        '  injections: [{ token: Child }],',
        '});',
        '',
      ].join('\n')],
    ]);
    const graphs = new Analyzer(memoryProgram(files)).extractAll();
    const two = graphs.find((graph) => graph.sourceFileName === TWO);
    const child = graphs.find((graph) => graph.sourceFileName === CHILD);
    expect(child?.borrowedRegistrations?.map((item) => item.containerId)).toEqual([two?.containerKey]);
    expect([...(child?.parentProvidedTokens ?? [])]).toEqual([...(two?.nodes.keys() ?? [])]);
  });
});
