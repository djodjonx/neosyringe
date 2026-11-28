import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOT = path.join(process.cwd(), 't06-lsp-virtual');
const MAIN = path.join(ROOT, 'usages.ts');
const FOREIGN = path.join(ROOT, 'foreign.ts');
const GENERIC = path.join(ROOT, 'generic.ts');
const MANY = path.join(ROOT, 'many.ts');
const MANY_PLAIN = path.join(ROOT, 'many-plain.ts');

const files = new Map<string, string>([
  [MAIN, `
    import { defineBuilderConfig, useInterface, type Container } from '@djodjonx/neosyringe';

    interface IFromA { id: number }

    export const containerB = defineBuilderConfig({
      injections: [],
    });
    containerB.resolve(useInterface<IFromA>());

    function getContainer(): Container {
      return containerB;
    }
    getContainer().resolve(useInterface<IFromA>());
  `],
  [FOREIGN, `
    interface Container { resolve<T>(x: unknown): T }
    declare const ioc: Container;
    class Svc {}
    ioc.resolve(Svc);
  `],
  [GENERIC, `
    import { containerB } from './usages';
    class Missing {}
    containerB.resolve<Missing>(Missing);
  `],
  [MANY, `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

    interface IBar { id: number }
    interface IFoo { id: number }
    class BarImpl implements IBar { id = 2 }

    export const containerM = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerM.resolveMany([useInterface<IBar>(), useInterface<IFoo>()]);
    const bag = { resolveMany(tokens: unknown[]): unknown[] { return tokens; } };
    bag.resolveMany([useInterface<IFoo>()]);
    const list = [useInterface<IFoo>()];
    containerM.resolveMany(list);
  `],
  // No defineBuilderConfig / definePartialConfig text: only the text of the resolveMany call brings the file to the analysis.
  [MANY_PLAIN, `
    import { containerB } from './usages';
    class Missing {}
    containerB.resolveMany([Missing]);
  `],
]);

describe('LSP resolution usages', () => {
  mkdirSync(ROOT, { recursive: true });
  for (const [fileName, text] of files) writeFileSync(fileName, text);

  const program = ts.createProgram([...files.keys()], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  });

  const modules = { typescript: ts };
  const pluginFactory = init(modules);
  const proxy = pluginFactory.create({
    languageService: {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    },
    project: {
      projectService: {
        logger: {
          info: () => {},
          loggingEnabled: () => false,
          startGroup: () => {},
          endGroup: () => {},
        },
      },
    },
  } as any);

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  function neoDiagnostics(fileName: string): ts.Diagnostic[] {
    return proxy.getSemanticDiagnostics(fileName).filter((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('[NeoSyringe]'),
    );
  }

  it('reports a known-container miss and a strict unknown receiver as errors', () => {
    const diagnostics = neoDiagnostics(MAIN);
    const missing = diagnostics.find((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('NEO_MISSING_PROVIDER'),
    );
    const unknown = diagnostics.find((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('NEO_UNKNOWN_CONTAINER'),
    );

    expect(missing?.category).toBe(ts.DiagnosticCategory.Error);
    expect(missing?.messageText).toContain("NEO_MISSING_PROVIDER: 'IFromA'");
    expect(unknown?.category).toBe(ts.DiagnosticCategory.Error);
    expect(unknown?.messageText).toContain('NEO_UNKNOWN_CONTAINER');
  });

  it('T06-F1 foreign Container type reports nothing', () => {
    const diagnostics = neoDiagnostics(FOREIGN);
    expect(diagnostics.filter((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('NEO_UNKNOWN_CONTAINER'),
    )).toHaveLength(0);
  });

  it('T06-F8 explicit generic resolve without a NeoSyringe import', () => {
    const diagnostics = neoDiagnostics(GENERIC);
    const missing = diagnostics.find((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('NEO_MISSING_PROVIDER'),
    );
    expect(missing?.category).toBe(ts.DiagnosticCategory.Error);
    expect(missing?.messageText).toContain('Missing');
  });

  it('E17-P11 resolveMany reports the missing element at its own position, ignores a homonym and flags a dynamic list', () => {
    const text = files.get(MANY) ?? '';
    const diagnostics = neoDiagnostics(MANY);
    const message = (item: ts.Diagnostic): string => (typeof item.messageText === 'string' ? item.messageText : '');
    const missing = diagnostics.filter((item) => message(item).includes('NEO_MISSING_PROVIDER'));
    const unknown = diagnostics.filter((item) => message(item).includes('NEO_UNKNOWN_CONTAINER'));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.category).toBe(ts.DiagnosticCategory.Error);
    expect(message(missing[0]!)).toContain("NEO_MISSING_PROVIDER: 'IFoo'");
    expect(missing[0]?.start).toBe(text.indexOf('useInterface<IFoo>()]'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.category).toBe(ts.DiagnosticCategory.Error);
    expect(message(unknown[0]!)).toContain('NEO_UNKNOWN_CONTAINER: resolveMany tokens are not a literal list');
    expect(unknown[0]?.start).toBe(text.indexOf('list);'));
  });

  it('E17-P11lsp a file with only a resolveMany call is analysed and reports the element position', () => {
    const text = files.get(MANY_PLAIN) ?? '';
    const missing = neoDiagnostics(MANY_PLAIN).filter((item) =>
      typeof item.messageText === 'string' && item.messageText.includes('NEO_MISSING_PROVIDER'),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.category).toBe(ts.DiagnosticCategory.Error);
    expect(missing[0]?.start).toBe(text.indexOf('Missing]'));
  });
});
