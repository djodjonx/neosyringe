import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ConfigCollector } from '../../src/analyzer/collectors/ConfigCollector';
import type { ConfigGraph, TokenId } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { CORPUS, fixtureFiles } from '../helpers/t03c1-corpus';
import { dumpExpectedExternal } from '../helpers/t03c1-dump';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FILE = captureRoot('expects-field/app.ts');

const HEADER = "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';";

function program(...blocks: string[]) {
  return memoryProgram(new Map([[FILE, `${HEADER}\n${blocks.join('\n')}\n`]]));
}

function simple(ids: readonly string[] | null): string[] | null {
  return ids === null ? null : ids.map((id) => id.split('_')[0] ?? id);
}

/** The oracle: the collector's own partials, folded the way the host folds them (nested first, own after). */
function foldedExpectations(config: ConfigGraph, configs: Map<string, ConfigGraph>, seen = new Set<string>()): TokenId[] {
  const found: TokenId[] = [];
  for (const link of config.extendsLinks ?? []) {
    if (seen.has(link.key)) continue;
    seen.add(link.key);
    const partial = configs.get(link.key);
    if (!partial) continue;
    found.push(...foldedExpectations(partial, configs, seen), ...(partial.expectedExternalTokens ?? []));
  }
  return found;
}

describe('T03 C1 the graph of a host carries what its partials expect', () => {
  it('W14 a host lists the tokens its extended partials declare with expects, in fold order, once', () => {
    const analyzer = new Analyzer(program(
      'class One {}',
      'class Two {}',
      'class Three {}',
      'export const inner = definePartialConfig({ expects: [Two, One], injections: [] });',
      'export const first = definePartialConfig({ extends: [inner], expects: [Three, One], injections: [] });',
      'export const second = definePartialConfig({ expects: [Three], injections: [] });',
      "export const host = defineBuilderConfig({ name: 'ExpectingHost', extends: [first, second], injections: [{ token: One }, { token: Two }, { token: Three }] });",
    ));
    const host = analyzer.extractAll().find((graph) => graph.containerName === 'ExpectingHost');
    expect(simple(host ? dumpExpectedExternal(host) : null)).toEqual(['Two', 'One', 'Three']);
  });

  it('W14 a builder with no partial, and a partial without expects, carry none', () => {
    const analyzer = new Analyzer(program(
      'class One {}',
      'export const plain = definePartialConfig({ injections: [{ token: One }] });',
      "export const alone = defineBuilderConfig({ name: 'Alone', injections: [{ token: One }] });",
      "export const withPlain = defineBuilderConfig({ name: 'WithPlain', extends: [plain], injections: [] });",
    ));
    const graphs = analyzer.extractAll();
    expect(graphs.map((graph) => dumpExpectedExternal(graph))).toEqual([null, null]);
  });

  it('W14 every graph of the corpus carries the folded expectations of its configuration', () => {
    let hosts = 0;
    for (const fixture of CORPUS) {
      const compiled = memoryProgram(fixtureFiles(fixture));
      const validation = fixture.validation ?? 'strict';
      const analyzer = new Analyzer(compiled, { validation });
      const { configs } = new ConfigCollector(compiled, compiled.getTypeChecker(), undefined, validation).collectAll();
      // A fixture that holds an unsupported shape makes extractAll throw, on base too (it is a golden entry).
      const graphs = (() => {
        try {
          return analyzer.extractAll();
        } catch {
          return [];
        }
      })();
      for (const graph of graphs) {
        const config = [...configs.values()].find((candidate) => candidate.type === 'builder'
          && candidate.containerKey === graph.containerKey);
        if (!config) continue;
        const expected = [...new Set(foldedExpectations(config, configs))];
        expect(simple(dumpExpectedExternal(graph)), `${fixture.name}:${graph.containerName}`)
          .toEqual(expected.length > 0 ? simple(expected) : null);
        if (expected.length > 0) hosts += 1;
      }
    }
    // The corpus holds hosts that fold a partial with expects (fixture "expects", twice).
    expect(hosts).toBeGreaterThanOrEqual(2);
  });

  it('W14 the field changes nothing in the generated code', () => {
    const graphs = new Analyzer(program(
      'class Needed {}',
      'export const part = definePartialConfig({ expects: [Needed], injections: [] });',
      "export const host = defineBuilderConfig({ name: 'GenHost', extends: [part], injections: [{ token: Needed }] });",
    )).extractAll();
    const host = graphs[0];
    if (!host) throw new Error('missing graph');
    expect(host.expectedExternalTokens?.size).toBe(1);
    const withField = new Generator(host, true).generate();
    const without = new Generator({ ...host, expectedExternalTokens: undefined }, true).generate();
    expect(withField).toBe(without);
  });
});
