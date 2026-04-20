import { describe, it, expect } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';
import * as path from 'path';

describe('LSP Diagnostics — multi-registration and async factories', () => {
  const modules = { typescript: ts };
  const pluginFactory = init(modules);

  const createMockLogger = () => ({
    info: () => {},
    loggingEnabled: () => false,
    startGroup: () => {},
    endGroup: () => {},
  });

  const createPluginProxy = (languageService: any) =>
    pluginFactory.create({
      languageService,
      project: { projectService: { logger: createMockLogger() } },
    } as any);

  const makeProgram = (fileName: string, fileContent: string) =>
    ts.createProgram({
      rootNames: [fileName],
      options: {},
      host: {
        ...ts.createCompilerHost({}),
        getSourceFile: (name) =>
          name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
        writeFile: () => {},
        getDefaultLibFileName: () => 'lib.d.ts',
        getCurrentDirectory: () => '/',
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (f) => f === fileName,
        readFile: (f) => (f === fileName ? fileContent : undefined),
      },
    });

  // ---------------------------------------------------------------------------
  // multi: true
  // ---------------------------------------------------------------------------

  it('should not report error for valid multi-registration', () => {
    const fileName = path.resolve('/tmp/multi-valid.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IPlugin { execute(): void; }
      class AuthPlugin implements IPlugin { execute() {} }
      class LogPlugin  implements IPlugin { execute() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: AuthPlugin, multi: true },
          { token: useInterface<IPlugin>(), provider: LogPlugin,  multi: true },
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBe(0);
  });

  it('should report type-mismatch error when multi provider does not satisfy interface', () => {
    const fileName = path.resolve('/tmp/multi-type-mismatch.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IPlugin { execute(): void; }

      class GoodPlugin implements IPlugin { execute() {} }
      class BadPlugin { run() {} }  // Does NOT implement IPlugin

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: GoodPlugin, multi: true },
          { token: useInterface<IPlugin>(), provider: BadPlugin,  multi: true },
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBeGreaterThan(0);
    expect(neo[0].messageText).toContain('Type mismatch');
  });

  it('should report missing dependency for a multi-provider that needs an unregistered dep', () => {
    const fileName = path.resolve('/tmp/multi-missing-dep.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IPlugin { execute(): void; }
      interface ILogger { log(m: string): void; }

      class AuthPlugin implements IPlugin {
        constructor(private logger: ILogger) {}
        execute() {}
      }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: AuthPlugin, multi: true },
          // ILogger is NOT registered — should report missing dep
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBeGreaterThan(0);
    expect(neo.some((d: any) => d.messageText.includes('Missing injection'))).toBe(true);
  });

  it('should report error for mixing multi and non-multi registrations of the same token', () => {
    const fileName = path.resolve('/tmp/multi-mixed.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IPlugin { execute(): void; }
      class AuthPlugin implements IPlugin { execute() {} }
      class LogPlugin  implements IPlugin { execute() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: AuthPlugin },           // no multi
          { token: useInterface<IPlugin>(), provider: LogPlugin, multi: true }, // multi!
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // async factories
  // ---------------------------------------------------------------------------

  it('should not report error for valid async factory (singleton)', () => {
    const fileName = path.resolve('/tmp/async-valid.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true
          }
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBe(0);
  });

  it('should report error for async factory with lifecycle: transient', () => {
    const fileName = path.resolve('/tmp/async-transient.ts');
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true,
            lifecycle: 'transient'
          }
        ]
      });
    `;

    const proxy = createPluginProxy({
      getSemanticDiagnostics: () => [],
      getProgram: () => makeProgram(fileName, fileContent),
    });

    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const neo = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neo.length).toBeGreaterThan(0);
    expect(neo[0].messageText).toContain('transient');
  });
});
