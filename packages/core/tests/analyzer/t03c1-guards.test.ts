import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FILE = captureRoot('guards/loops.ts');
const HEADER = "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';";

describe('T03 C1 loops in the configuration never overflow the stack', () => {
  it('W1 two partials that extend each other are folded into the host once', () => {
    const source = [
      HEADER,
      'class FromA {}',
      'class FromB {}',
      'export const a = definePartialConfig({ extends: [b], injections: [{ token: FromA }] });',
      'export const b = definePartialConfig({ extends: [a], injections: [{ token: FromB }] });',
      "export const host = defineBuilderConfig({ name: 'LoopHost', extends: [a], injections: [] });",
      '',
    ].join('\n');
    const analyzer = new Analyzer(memoryProgram(new Map([[FILE, source]])));
    const host = analyzer.extractAll().find((graph) => graph.containerName === 'LoopHost');
    expect([...(host?.nodes.keys() ?? [])].map((id) => id.split('_')[0])).toEqual(['FromB', 'FromA']);
    expect(host?.errors).toEqual([]);
    expect(analyzer.extractAllErrors()).toEqual([]);
  });

  it('W2 two builders that name each other as parent give graphs without looping', () => {
    const source = [
      HEADER,
      'class One {}',
      'class Two {}',
      "export const first = defineBuilderConfig({ name: 'LoopFirst', useContainer: second, injections: [{ token: One }] });",
      "export const second = defineBuilderConfig({ name: 'LoopSecond', useContainer: first, injections: [{ token: Two }] });",
      '',
    ].join('\n');
    const analyzer = new Analyzer(memoryProgram(new Map([[FILE, source]])));
    const graphs = analyzer.extractAll();
    expect(graphs.map((graph) => graph.containerName)).toEqual(['LoopFirst', 'LoopSecond']);
    expect(graphs.map((graph) => [...graph.nodes.keys()].length)).toEqual([1, 1]);
    for (const graph of graphs) expect(graph.parentProvidedTokens?.size).toBeGreaterThan(0);
  });

  it('W6 a root registered by an extended partial is known to the closed host', () => {
    const source = [
      "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';",
      'class Provided {}',
      'class Own {}',
      'export const part = definePartialConfig({ injections: [{ token: Provided }] });',
      'export const host = defineBuilderConfig({',
      "  name: 'PartialRoot',",
      "  optimization: { mode: 'closed', roots: [Provided, Own] },",
      '  extends: [part],',
      '  injections: [{ token: Own }],',
      '});',
      '',
    ].join('\n');
    const analyzer = new Analyzer(memoryProgram(new Map([[FILE, source]])));
    const host = analyzer.extractAll().find((graph) => graph.containerName === 'PartialRoot');
    expect(host?.publicRoots?.map((id) => id.split('_')[0])).toEqual(['Provided', 'Own']);
    expect(host?.errors).toEqual([]);
    expect(analyzer.extractAllErrors()).toEqual([]);
  });
});
