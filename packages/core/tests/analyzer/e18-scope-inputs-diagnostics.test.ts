import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { stableCodeOf } from '../../src/analyzer/errors/stableDiagnostic';
import { containerIROf } from '../../src/analyzer/ir';
import type { AnalysisError } from '../../src/analyzer/types';

/**
 * E18 `scopeInputs` in the analyzer: a literal list of interface and property tokens is read, and everything else is
 * reported with a stable code at the position of what is wrong: a list that is not literal or holds a class token or
 * an object (`{ token, multi }`), a token twice, a token a local or folded registration also provides, and a partial
 * that declares inputs. An input satisfies a dependency, and a scope of a closed container does not export it.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = path.join(process.cwd(), 'e18-virtual');

const TOKENS = path.join(ROOT, 'tokens.ts');
const OK = path.join(ROOT, 'ok.ts');
const CONSUMER = path.join(ROOT, 'consumer.ts');
const LIST = path.join(ROOT, 'list.ts');
const SPREAD = path.join(ROOT, 'spread.ts');
const CLASS_TOKEN = path.join(ROOT, 'class-token.ts');
const OBJECT = path.join(ROOT, 'object.ts');
const DUPLICATE = path.join(ROOT, 'duplicate.ts');
const LOCAL = path.join(ROOT, 'local.ts');
const FOLDED = path.join(ROOT, 'folded.ts');
const PARTIAL = path.join(ROOT, 'partial.ts');
const CLOSED = path.join(ROOT, 'closed.ts');
const PARENT = path.join(ROOT, 'parent.ts');
const BOUND = path.join(ROOT, 'bound.ts');
const MULTI = path.join(ROOT, 'multi.ts');

const IMPORTS = `import { defineBuilderConfig, definePartialConfig, useInterface, useProperty } from '@djodjonx/neosyringe';`;

const files = new Map<string, string>([
  [TOKENS, `
    export interface IReq { id: string }
    export interface IOther { id: string }
  `],
  [OK, `
    ${IMPORTS}
    import { IReq, IOther } from './tokens';
    class Reader { constructor(readonly req: IReq, readonly retries: number) {} }
    const retries = useProperty<number>(Reader, 'retries');
    const needs = definePartialConfig({
      expects: [useInterface<IReq>(), retries, useInterface<IOther>()],
      injections: [{ token: Reader }],
    });
    export const okBox = defineBuilderConfig({
      name: 'Ok',
      scopeInputs: [useInterface<IReq>(), retries, useInterface<IOther>()],
      extends: [needs],
      injections: [],
    });
  `],
  [CONSUMER, `
    ${IMPORTS}
    import { IReq } from './tokens';
    class Reader { constructor(readonly req: IReq, readonly retries: number) {} }
    export const consumerBox = defineBuilderConfig({
      name: 'Consumer',
      scopeInputs: [useInterface<IReq>(), useProperty<number>(Reader, 'retries')],
      injections: [{ token: Reader }],
    });
  `],
  [LIST, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const list = [useInterface<IReq>()];
    export const listBox = defineBuilderConfig({
      scopeInputs: list,
      injections: [],
    });
  `],
  [SPREAD, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const rest = [useInterface<IReq>()];
    export const spreadBox = defineBuilderConfig({
      scopeInputs: [...rest],
      injections: [],
    });
  `],
  [CLASS_TOKEN, `
    ${IMPORTS}
    class Plain {}
    export const classBox = defineBuilderConfig({
      scopeInputs: [Plain],
      injections: [],
    });
  `],
  [OBJECT, `
    ${IMPORTS}
    import { IReq } from './tokens';
    export const objectBox = defineBuilderConfig({
      scopeInputs: [{ token: useInterface<IReq>(), multi: true }],
      injections: [],
    });
  `],
  [DUPLICATE, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const req = useInterface<IReq>();
    export const duplicateBox = defineBuilderConfig({
      scopeInputs: [req, req],
      injections: [],
    });
  `],
  [LOCAL, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const req = useInterface<IReq>();
    export const localBox = defineBuilderConfig({
      scopeInputs: [req],
      injections: [
        { token: req, useValue: { id: 'local' } },
      ],
    });
  `],
  [MULTI, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const req = useInterface<IReq>();
    export const multiBox = defineBuilderConfig({
      scopeInputs: [req],
      injections: [
        { token: req, useValue: { id: 'many' }, multi: true },
      ],
    });
  `],
  [FOLDED, `
    ${IMPORTS}
    import { IReq } from './tokens';
    const req = useInterface<IReq>();
    const shared = definePartialConfig({
      injections: [
        { token: req, useValue: { id: 'shared' } },
      ],
    });
    export const foldedBox = defineBuilderConfig({
      scopeInputs: [req],
      extends: [shared],
      injections: [],
    });
  `],
  [PARTIAL, `
    ${IMPORTS}
    import { IReq } from './tokens';
    export const withInputs = definePartialConfig({
      scopeInputs: [useInterface<IReq>()],
      injections: [],
    });
    export const partialBox = defineBuilderConfig({
      extends: [withInputs],
      injections: [],
    });
  `],
  [PARENT, `
    ${IMPORTS}
    import { IReq } from './tokens';
    class Page { constructor(readonly req: IReq) {} }
    export const requests = defineBuilderConfig({
      name: 'Requests',
      scopeInputs: [useInterface<IReq>()],
      injections: [],
    });
    export const child = defineBuilderConfig({
      name: 'Child',
      useContainer: requests,
      injections: [{ token: Page }],
    });
  `],
  [BOUND, `
    ${IMPORTS}
    import type { BoundContainer, CoreContainer } from '@djodjonx/neosyringe';
    import { IReq, IOther } from './tokens';
    const req = useInterface<IReq>();
    export const boundBox = defineBuilderConfig({ name: 'Bound', scopeInputs: [req], injections: [] });
    export function viaCore(scope: CoreContainer) { return scope.resolve(useInterface<IOther>()); }
    export function viaBound(scope: BoundContainer<readonly [typeof req], 'full'>) { return scope.resolve(useInterface<IOther>()); }
  `],
  [CLOSED, `
    ${IMPORTS}
    import { IReq } from './tokens';
    class Page { constructor(readonly req: IReq) {} }
    export const closedBox = defineBuilderConfig({
      name: 'Closed',
      scopeInputs: [useInterface<IReq>()],
      optimization: { mode: 'closed', roots: [Page] },
      injections: [{ token: Page }],
    });
    const scope = closedBox.createScope({ values: [{ token: useInterface<IReq>(), useValue: { id: '1' } }] });
    scope.resolve(useInterface<IReq>());
    scope.resolve(Page);
  `],
]);

function createProgram(sources: Map<string, string>): ts.Program {
  mkdirSync(ROOT, { recursive: true });
  for (const [fileName, text] of sources) writeFileSync(fileName, text);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  };
  return ts.createProgram([...sources.keys()], options);
}

const CODES = new Set([
  'NEO_CONFIG_UNSUPPORTED',
  'NEO_DUPLICATE_PROVIDER',
  'NEO_MISSING_PROVIDER',
  'NEO_ROOT_NOT_EXPORTED',
  'NEO_UNKNOWN_CONTAINER',
]);

/** `code line:column text` of the diagnostics of the topic, in the order the analyzer lists them. */
function found(errors: readonly AnalysisError[]): string[] {
  return errors
    .filter((error) => CODES.has(stableCodeOf(error) ?? ''))
    .map((error) => {
      const position = error.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
      const text = error.node.getText().replace(/\s+/g, ' ');
      return `${stableCodeOf(error)} ${position.line + 1}:${position.character + 1} ${text}`;
    });
}

/**
 * Every error, with or without a stable code. A partial `expects` that the host does not provide is reported without
 * a code, so `found` does not list it.
 */
function everything(errors: readonly AnalysisError[]): string[] {
  return errors.map((error) => `${stableCodeOf(error) ?? error.type}: ${error.message}`);
}

/** `line:column` (1-based) of the `occurrence`-th `needle` of `file`. */
function at(file: string, needle: string, occurrence = 1): string {
  const lines = (files.get(file) ?? '').split('\n');
  let seen = 0;
  for (const [index, text] of lines.entries()) {
    let from = text.indexOf(needle);
    while (from >= 0) {
      seen += 1;
      if (seen === occurrence) return `${index + 1}:${from + 1}`;
      from = text.indexOf(needle, from + 1);
    }
  }
  throw new Error(`no ${needle} in ${file}`);
}

describe('E18 scope inputs diagnostics', () => {
  let analyzer: Analyzer;

  beforeAll(() => {
    analyzer = new Analyzer(createProgram(files));
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('E18-P13 a literal list of interface and property tokens is read in order, and satisfies its consumers', () => {
    // Unfiltered: the partial `needs` expects the three inputs, and a builder that does not provide one is reported
    // without a code.
    expect(everything(analyzer.extractForFile(OK).errors)).toEqual([]);
    const graph = analyzer.extractAll().find((candidate) => candidate.containerName === 'Ok');
    const inputs: unknown = graph ? Reflect.get(graph, 'scopeInputs') : undefined;
    const ids = Array.isArray(inputs) ? inputs.map((input: unknown) => Reflect.get(Object(input), 'tokenId')) : undefined;
    expect(ids?.map((id) => String(id).split('_')[0])).toEqual(['IReq', 'PropertyToken:Reader.retries', 'IOther']);
  });

  it('E18-P13 a class of the builder that depends on an input token gets no NEO_MISSING_PROVIDER', () => {
    expect(everything(analyzer.extractForFile(CONSUMER).errors)).toEqual([]);
  });

  it('E18-P13 the IR lists the inputs as borrowed registrations, and a container without input has no inputs key', () => {
    const graphs = analyzer.extractAll();
    const ok = graphs.find((candidate) => candidate.containerName === 'Ok');
    const child = graphs.find((candidate) => candidate.containerName === 'Child');
    expect(ok && child, 'both graphs exist').toBeTruthy();
    if (!ok || !child) return;
    const ir = containerIROf(ok, ROOT);
    const listed: unknown = Reflect.get(ir, 'inputs');
    expect(Array.isArray(listed) ? listed.map((input: unknown) => Reflect.get(Object(input), 'slot')) : listed).toEqual([0, 1, 2]);
    const inputs = ir.registrations.filter((registration) => {
      const kind: unknown = Reflect.get(registration.provider, 'kind');
      return kind === 'input';
    });
    expect(inputs.map((registration) => [registration.lifecycle, registration.ownership])).toEqual([
      ['singleton', 'borrowed'],
      ['singleton', 'borrowed'],
      ['singleton', 'borrowed'],
    ]);
    expect('inputs' in containerIROf(child, ROOT), 'no inputs key without inputs').toBe(false);
  });

  it('E18-P13 a list that is a variable is reported at the variable', () => {
    expect(found(analyzer.extractForFile(LIST).errors)).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(LIST, 'list,')} list`,
    ]);
  });

  it('E18-P13 a list with a spread is reported at the list', () => {
    expect(found(analyzer.extractForFile(SPREAD).errors)).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(SPREAD, '[...rest]')} [...rest]`,
    ]);
  });

  it('E18-P13 a class token is reported at the element', () => {
    expect(found(analyzer.extractForFile(CLASS_TOKEN).errors)).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(CLASS_TOKEN, 'Plain]')} Plain`,
    ]);
  });

  it('E18-P13 an input given as { token, multi } is reported at the element', () => {
    const errors = analyzer.extractForFile(OBJECT).errors;
    expect(found(errors)).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(OBJECT, '{ token: useInterface<IReq>(), multi: true }')} { token: useInterface<IReq>(), multi: true }`,
    ]);
    expect(errors.find((error) => stableCodeOf(error) === 'NEO_CONFIG_UNSUPPORTED')?.message).toContain('multi');
  });

  it('E18-P13 a token declared twice is a duplicate at the second one', () => {
    expect(found(analyzer.extractForFile(DUPLICATE).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, 'req', 3)} req`,
    ]);
  });

  it('E18-P13 a token a local registration also provides is a duplicate at that registration', () => {
    expect(found(analyzer.extractForFile(LOCAL).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(LOCAL, '{ token: req')} { token: req, useValue: { id: 'local' } }`,
    ]);
  });

  it('E18-P13 a token a multi registration also provides is a duplicate at that registration', () => {
    expect(found(analyzer.extractForFile(MULTI).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(MULTI, '{ token: req')} { token: req, useValue: { id: 'many' }, multi: true }`,
    ]);
  });

  it('E18-P13 a token a folded partial registers is a duplicate at that registration', () => {
    expect(found(analyzer.extractForFile(FOLDED).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(FOLDED, '{ token: req')} { token: req, useValue: { id: 'shared' } }`,
    ]);
  });

  it('E18-P13 a partial that declares inputs is refused, and says partial inputs are not supported', () => {
    const errors = analyzer.extractForFile(PARTIAL).errors;
    expect(found(errors)).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(PARTIAL, 'scopeInputs')} scopeInputs: [useInterface<IReq>()]`,
    ]);
    expect(errors.find((error) => stableCodeOf(error) === 'NEO_CONFIG_UNSUPPORTED')?.message).toBe(
      'NEO_CONFIG_UNSUPPORTED: scopeInputs is not supported in a partial config in this version: declare it on the builder.',
    );
  });

  it('E18-P13 an input is not provided to a child that names the container as its parent', () => {
    expect(found(analyzer.extractForFile(PARENT).errors)).toEqual([
      `NEO_MISSING_PROVIDER ${at(PARENT, 'token: Page')} token: Page`,
    ]);
    const child = analyzer.extractAll().find((candidate) => candidate.containerName === 'Child');
    const provided = [...(child?.parentProvidedTokens ?? [])];
    expect(child, 'the child has a graph').toBeDefined();
    expect(provided.filter((id) => id.startsWith('IReq_')), 'the parent does not hand its input down').toEqual([]);
  });

  it('E18-P13 a scope of a closed container does not export an input, and still resolves a root', () => {
    expect(found(analyzer.extractForFile(CLOSED).errors)).toEqual([
      `NEO_ROOT_NOT_EXPORTED ${at(CLOSED, 'scope.resolve(useInterface')} scope.resolve(useInterface<IReq>())`,
    ]);
  });

  it('E18-P13 a receiver typed BoundContainer is classified like one typed CoreContainer', () => {
    // A ContainerTemplate has no `resolve` member (its type is createScope and destroy), so no call can be written on it.
    expect(found(analyzer.extractForFile(BOUND).errors)).toEqual([
      `NEO_UNKNOWN_CONTAINER ${at(BOUND, 'scope.resolve', 1)} scope.resolve(useInterface<IOther>())`,
      `NEO_UNKNOWN_CONTAINER ${at(BOUND, 'scope.resolve', 2)} scope.resolve(useInterface<IOther>())`,
    ]);
  });
});
