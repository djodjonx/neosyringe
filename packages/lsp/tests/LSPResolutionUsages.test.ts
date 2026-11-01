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
});
