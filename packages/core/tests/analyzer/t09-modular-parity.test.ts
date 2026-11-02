import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { ServiceDefinition } from '../../src/analyzer/types';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const PART = captureRoot('parity-part.ts');
const APP = captureRoot('parity-app.ts');

const PART_SOURCE = [
  "import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
  'export interface HeldPort { n: number }',
  'export const part = definePartialConfig({',
  '  injections: [',
  '    { token: useInterface<HeldPort>(), useValue: { n: 2 }, ownership: \'borrowed\' },',
  '  ],',
  '});',
  '',
].join('\n');

const APP_SOURCE = [
  "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
  "import * as P from './parity-part';",
  'export interface DirectPort { n: number }',
  'export const container = defineBuilderConfig({',
  "  name: 'T09Host',",
  '  extends: [P.part],',
  '  injections: [',
  '    { token: useInterface<DirectPort>(), useValue: { n: 1 }, ownership: \'borrowed\' },',
  '  ],',
  '});',
  '',
].join('\n');

function fields(definition: ServiceDefinition | undefined): { ownership?: string; valueCapture?: string } {
  return { ownership: definition?.ownership, valueCapture: definition?.valueCapture };
}

describe('T09 modular parity', () => {
  it('T09-P17 modular path parity', () => {
    const analyzer = new Analyzer(memoryProgram(new Map([[PART, PART_SOURCE], [APP, APP_SOURCE]])));
    const legacy = analyzer.extractAll().find((graph) => graph.containerId === 'T09Host');
    const legacyDirect = [...(legacy?.nodes.values() ?? [])].find((node) => node.service.tokenId.includes('DirectPort'));
    const legacyPartial = [...(legacy?.nodes.values() ?? [])].find((node) => node.service.tokenId.includes('HeldPort'));
    const configs = [...analyzer.extractForFile(APP).configs.values()];
    const builder = configs.find((config) => config.type === 'builder' && config.name === 'container');
    const partial = configs.find((config) => config.type === 'partial' && config.name === 'part');
    const modularDirect = [...(builder?.localInjections.values() ?? [])].find((info) => info.definition.tokenId.includes('DirectPort'));
    const modularPartial = [...(partial?.localInjections.values() ?? [])].find((info) => info.definition.tokenId.includes('HeldPort'));

    expect(fields(modularDirect?.definition)).toEqual(fields(legacyDirect?.service));
    expect(modularDirect?.definition.ownership).toBe('borrowed');
    expect(fields(modularPartial?.definition)).toEqual(fields(legacyPartial?.service));
    expect(modularPartial?.definition.ownership).toBe('borrowed');
    expect(modularPartial?.definition.valueCapture).toContain('P.part.injections[');
  });
});
