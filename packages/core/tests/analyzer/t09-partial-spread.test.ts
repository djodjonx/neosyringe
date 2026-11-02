import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FILE = captureRoot('spread.ts');

const SOURCE = [
  "import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
  'export interface HeldPort { n: number }',
  'const common: object[] = [];',
  'export const part = definePartialConfig({',
  '  injections: [',
  '    ...common,',
  '    { token: useInterface<HeldPort>(), useValue: { n: 1 } },',
  '  ],',
  '});',
  'export const host = defineBuilderConfig({',
  "  name: 'T09SpreadHost',",
  '  extends: [part],',
  '  injections: [],',
  '});',
  '',
].join('\n');

describe('T09 partial spread', () => {
  it('T09-P25 partial spread', () => {
    const analyzer = new Analyzer(memoryProgram(new Map([[FILE, SOURCE]])));
    const host = analyzer.extractAll().find((graph) => graph.containerId === 'T09SpreadHost');
    const legacy = (host?.errors ?? []).find((error) => error.code === 'NEO_CONFIG_UNSUPPORTED');
    const partial = [...analyzer.extractForFile(FILE).configs.values()].find((config) => config.type === 'partial');
    const modular = (partial?.valueErrors ?? []).find((error) => error.code === 'NEO_CONFIG_UNSUPPORTED');

    expect(legacy?.code).toBe('NEO_CONFIG_UNSUPPORTED');
    expect(legacy?.message).toContain('spread');
    expect(legacy?.message).toContain('useValue');
    expect(modular?.code).toBe('NEO_CONFIG_UNSUPPORTED');
    expect(modular?.message).toContain('spread');
    expect(modular?.message).toContain('useValue');
  });
});
