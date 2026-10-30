import { describe, expect, it } from 'vitest';
import { ConfigCollector } from '../../src/analyzer/collectors/ConfigCollector';
import { createVirtualProgram } from '../helpers/createVirtualProgram';

const ALIASED = `
import {
  definePartialConfig as partialOf,
  defineBuilderConfig as builder,
  declareContainerTokens as legacyTokens,
} from '@djodjonx/neosyringe';

interface ILogger { log(message: string): void; }
class Logger implements ILogger { log(_message: string) {} }

const shared = partialOf({
  injections: [{ token: Logger }],
});

const parent = legacyTokens<{ ILogger: ILogger }>(null);

export const app = builder({
  name: 'App',
  extends: [shared],
  useContainer: parent,
  injections: [],
});
`;

describe('T01 ConfigCollector provenance', () => {
  it('T01-P8-collector', () => {
    const program = createVirtualProgram('t01-collector.ts', ALIASED);
    const configs = [...new ConfigCollector(program, program.getTypeChecker()).collect().values()];
    const partial = configs.find((config) => config.type === 'partial' && config.name === 'shared');
    const container = configs.find((config) => config.type === 'builder' && config.name === 'app');

    expect(partial).toBeDefined();
    expect(container?.extendsRefs).toContain('shared');
    expect(container?.legacyParentTokens?.size ?? 0).toBeGreaterThan(0);
  });
});
