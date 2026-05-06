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
      cycleErrors.some(e =>
        e.message.includes('->') &&
        /IPlugin.*->.*IPlugin/.test(e.message)
      )
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

  it('should emit one cycle error per multi-provider participant, not just [0]', () => {
    // IPlugin has two multi-providers (PluginA and PluginB), each requiring IPlugin
    // in their constructor. This creates a self-cycle for the multi-injection token
    // with 2 providers — both should generate errors, not just the first one.
    const source = `
      interface IPlugin { run(): void; }
      class PluginA implements IPlugin {
        constructor(private p: IPlugin) {}
        run() {}
      }
      class PluginB implements IPlugin {
        constructor(private p: IPlugin) {}
        run() {}
      }
      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginB, multi: true }
        ]
      });
    `;

    const result = new Analyzer(createProgram('test.ts', source)).extractForFile('test.ts');
    const cycleErrors = result.errors.filter(e => e.type === 'cycle');
    // Both PluginA and PluginB participate in the self-cycle — expect exactly 2 errors.
    expect(cycleErrors.length).toBe(2);
  });
});
