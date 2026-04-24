import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

function createProgram(fileName: string, content: string): ts.Program {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (n, l) =>
    n === fileName ? ts.createSourceFile(fileName, content, l, true) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
}

describe('CycleValidator — multi-injection tokens', () => {
  it('should detect a self-cycle where a multi token depends on itself', () => {
    // PluginA requires IPlugin in its constructor, and is registered as the
    // multi-provider for IPlugin → IPlugin_hash → IPlugin_hash cycle.
    const source = `
      interface IPlugin { run(): void; }
      class PluginA implements IPlugin {
        constructor(private p: IPlugin) {}
        run() {}
      }
      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true }
        ]
      });
    `;

    const result = new Analyzer(createProgram('test.ts', source)).extractForFile('test.ts');
    const cycleErrors = result.errors.filter(e => e.type === 'cycle');
    expect(cycleErrors.length).toBeGreaterThan(0);
    expect(
      cycleErrors.some(e => e.message.includes('IPlugin') && e.message.includes('->'))
    ).toBe(true);
  });

  it('should not raise a false positive when multi and local tokens do not cycle', () => {
    const source = `
      interface IPlugin { run(): void; }
      class ServiceB {}
      class PluginA implements IPlugin {
        constructor(private b: ServiceB) {}
        run() {}
      }
      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: ServiceB }
        ]
      });
    `;

    const result = new Analyzer(createProgram('test.ts', source)).extractForFile('test.ts');
    const cycleErrors = result.errors.filter(e => e.type === 'cycle');
    expect(cycleErrors.length).toBe(0);
  });
});
