import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

function createProgram(fileName: string, content: string): ts.Program {
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName ? ts.createSourceFile(fileName, content, languageVersion) : original(name, languageVersion);
  return ts.createProgram([fileName], {}, host);
}

describe('T09 ownership', () => {
  it('T09-P13 ownership', () => {
    const borrowedProgram = createProgram('borrowed.ts', `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }
      interface ExternalPort { close(): void }
      export const container = defineBuilderConfig({
        name: 'T09Borrowed',
        injections: [{
          token: useInterface<ExternalPort>(),
          useFactory: true,
          dependencies: [],
          ownership: 'borrowed',
          provider: () => ({ close() {} }),
        }],
      });
    `);
    const borrowed = new Analyzer(borrowedProgram).extract();
    const node = [...borrowed.nodes.values()].find((item) => item.service.tokenId.includes('ExternalPort'));
    expect(node?.service.ownership).toBe('borrowed');

    const ownedValueProgram = createProgram('owned-value.ts', `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }
      interface ConfigPort { id: number }
      export const container = defineBuilderConfig({
        name: 'T09OwnedValue',
        injections: [{
          token: useInterface<ConfigPort>(),
          useValue: { id: 1 },
          ownership: 'owned',
        }],
      });
    `);
    const ownedValue = new Analyzer(ownedValueProgram).extract();
    const diagnostic = (ownedValue.errors ?? []).find((error) => error.code === 'NEO_CONFIG_UNSUPPORTED');
    expect(diagnostic?.code).toBe('NEO_CONFIG_UNSUPPORTED');
    expect(diagnostic?.message).toContain('useValue');
    expect(diagnostic?.message).toContain('owned');
  });
});
