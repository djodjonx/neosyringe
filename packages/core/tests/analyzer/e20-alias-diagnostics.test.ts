import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { stableCodeOf } from '../../src/analyzer/errors/stableDiagnostic';
import { containerIROf } from '../../src/analyzer/ir';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { GraphValidator } from '../../src/generator/GraphValidator';

/**
 * E20 `useExisting` in the analyzer: an alias is a registration of its own whose only dependency is its target. A
 * target the container cannot reach, a cycle through aliases, and a type the target does not have are reported at the
 * alias; everything an alias must not carry (a provider, a factory, a value, a lifecycle, an ownership, a dependency
 * list, `multi`, a property token, an `eager` listing) is `NEO_CONFIG_UNSUPPORTED` with the position of what is wrong.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = path.join(process.cwd(), 'e20-virtual');

const TOKENS = path.join(ROOT, 'tokens.ts');
const OK = path.join(ROOT, 'ok.ts');
const SUBTYPE = path.join(ROOT, 'subtype.ts');
const WRONG = path.join(ROOT, 'wrong.ts');
const MISSING = path.join(ROOT, 'missing.ts');
const CYCLE = path.join(ROOT, 'cycle.ts');
const MIXED = path.join(ROOT, 'mixed.ts');
const REFUSE = path.join(ROOT, 'refuse.ts');
const DUPLICATE = path.join(ROOT, 'duplicate.ts');
const CAPTURE = path.join(ROOT, 'capture.ts');
const TRANSIENT = path.join(ROOT, 'transient.ts');
const CLOSED = path.join(ROOT, 'closed.ts');
const PRUNED = path.join(ROOT, 'pruned.ts');
const PARENT = path.join(ROOT, 'parent.ts');
const USAGE = path.join(ROOT, 'usage.ts');
const SCOPED = path.join(ROOT, 'scoped.ts');
const NONAME = path.join(ROOT, 'noname.ts');
const PARTIAL = path.join(ROOT, 'partial.ts');

const IMPORTS = `import { defineBuilderConfig, definePartialConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
import { IThing, IOther, IPeer } from './tokens';`;

const files = new Map<string, string>([
  [TOKENS, `
    export interface IThing { id: string }
    export interface IOther { label: string }
    export interface IPeer { id: string }
  `],
  [OK, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    class Consumer { constructor(readonly thing: IThing) {} }
    export const okBox = defineBuilderConfig({
      name: 'Ok',
      injections: [
        { token: Impl },
        { token: useInterface<IThing>(), useExisting: Impl },
        { token: Consumer },
      ],
    });
  `],
  [SUBTYPE, `
    ${IMPORTS}
    class Wide implements IThing { id = 'wide'; extra = 1; }
    export const subtypeBox = defineBuilderConfig({
      name: 'Subtype',
      injections: [{ token: Wide }, { token: useInterface<IThing>(), useExisting: Wide }],
    });
  `],
  [WRONG, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    export const wrongBox = defineBuilderConfig({
      name: 'Wrong',
      injections: [
        { token: Impl },
        { token: useInterface<IOther>(), useExisting: Impl },
      ],
    });
  `],
  [MISSING, `
    ${IMPORTS}
    const thing = useInterface<IThing>();
    const gone = useInterface<IPeer>();
    export const missingBox = defineBuilderConfig({
      name: 'Missing',
      injections: [{ token: thing, useExisting: gone }],
    });
  `],
  [CYCLE, `
    ${IMPORTS}
    const thing = useInterface<IThing>();
    const peer = useInterface<IPeer>();
    export const cycleBox = defineBuilderConfig({
      name: 'Cycle',
      injections: [
        { token: thing, useExisting: peer },
        { token: peer, useExisting: thing },
      ],
    });
  `],
  [MIXED, `
    ${IMPORTS}
    const thing = useInterface<IThing>();
    class Svc { id = 'svc'; constructor(readonly inner: IThing) {} }
    export const mixedBox = defineBuilderConfig({
      name: 'Mixed',
      injections: [
        { token: Svc },
        { token: thing, useExisting: Svc },
      ],
    });
  `],
  [REFUSE, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    class Holder { x = 1; }
    const thing = useInterface<IThing>();
    export const r1 = defineBuilderConfig({ name: 'R1', injections: [{ token: Impl }, { token: thing, useExisting: Impl, multi: true }] });
    export const r2 = defineBuilderConfig({ name: 'R2', injections: [{ token: Impl, multi: true }, { token: thing, useExisting: Impl }] });
    export const r3 = defineBuilderConfig({ name: 'R3', injections: [{ token: Impl }, { token: thing, useExisting: Impl, provider: Impl }] });
    export const r4 = defineBuilderConfig({ name: 'R4', injections: [{ token: Impl }, { token: thing, useExisting: Impl, useFactory: true, provider: () => new Impl() }] });
    export const r5 = defineBuilderConfig({ name: 'R5', injections: [{ token: Impl }, { token: thing, useExisting: Impl, useValue: { id: 'v' } }] });
    export const r6 = defineBuilderConfig({ name: 'R6', injections: [{ token: Impl }, { token: thing, useExisting: Impl, lifecycle: 'transient' }] });
    export const r7 = defineBuilderConfig({ name: 'R7', injections: [{ token: Impl }, { token: thing, useExisting: Impl, ownership: 'borrowed' }] });
    export const r8 = defineBuilderConfig({ name: 'R8', injections: [{ token: Impl }, { token: thing, useExisting: Impl, dependencies: [] }] });
    export const r9 = defineBuilderConfig({ name: 'R9', injections: [{ token: Impl }, { token: useProperty<number>(Holder, 'x'), useExisting: Impl }] });
    export const r10 = defineBuilderConfig({
      name: 'R10',
      optimization: { mode: 'closed', roots: [Impl], eager: [thing] },
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }],
    });
    export const r11 = defineBuilderConfig({
      name: 'R11',
      injections: [{ token: Impl }, { token: thing, useExisting: Impl, scoped: true }],
    });
  `],
  [DUPLICATE, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    const thing = useInterface<IThing>();
    export const d1 = defineBuilderConfig({
      name: 'D1',
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }, { token: thing, useExisting: Impl }],
    });
    export const d2 = defineBuilderConfig({
      name: 'D2',
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }, { token: thing, useValue: { id: 'v' } }],
    });
    export const d3 = defineBuilderConfig({
      name: 'D3',
      scopeInputs: [thing],
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }],
    });
    export const d4 = defineBuilderConfig({
      name: 'D4',
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }, { token: thing, useValue: { id: 'many' }, multi: true }],
    });
    export const d5 = defineBuilderConfig({
      name: 'D5',
      injections: [{ token: Impl }, { token: thing, useValue: { id: 'many' }, multi: true }, { token: thing, useExisting: Impl }],
    });
  `],
  [CAPTURE, `
    ${IMPORTS}
    class Short implements IThing { id = 'short'; dispose(): void {} }
    class Cache { constructor(readonly thing: IThing) {} }
    export const captureBox = defineBuilderConfig({
      name: 'Capture',
      injections: [
        { token: Short, lifecycle: 'transient' },
        { token: useInterface<IThing>(), useExisting: Short },
        { token: Cache },
      ],
    });
  `],
  [TRANSIENT, `
    ${IMPORTS}
    class Short implements IThing { id = 'short'; dispose(): void {} }
    class Fresh { constructor(readonly thing: IThing) {} }
    export const transientBox = defineBuilderConfig({
      name: 'Transient',
      injections: [
        { token: Short, lifecycle: 'transient' },
        { token: useInterface<IThing>(), useExisting: Short },
        { token: Fresh, lifecycle: 'transient' },
      ],
    });
  `],
  [CLOSED, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    const thing = useInterface<IThing>();
    export const closedBox = defineBuilderConfig({
      name: 'ClosedAlias',
      optimization: { mode: 'closed', roots: [thing] },
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }],
    });
  `],
  [PRUNED, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    class Other { id = 'other'; }
    export const prunedBox = defineBuilderConfig({
      name: 'Pruned',
      optimization: { mode: 'closed', roots: [Other] },
      injections: [{ token: Impl }, { token: useInterface<IThing>(), useExisting: Impl }, { token: Other }],
    });
  `],
  [PARENT, `
    ${IMPORTS}
    class Pub implements IThing { id = 'pub'; }
    class Priv implements IPeer { id = 'priv'; }
    export const parent = defineBuilderConfig({
      name: 'Parent',
      optimization: { mode: 'closed', roots: [Pub] },
      injections: [{ token: Pub }, { token: Priv }],
    });
    export const child = defineBuilderConfig({
      name: 'Child',
      useContainer: parent,
      injections: [
        { token: useInterface<IThing>(), useExisting: Pub },
        { token: useInterface<IPeer>(), useExisting: Priv },
      ],
    });
  `],
  [SCOPED, `
    ${IMPORTS}
    class Pub implements IThing { id = 'pub'; }
    class Local implements IThing { id = 'local'; }
    export const scopedParent = defineBuilderConfig({
      name: 'ScopedParent',
      injections: [{ token: Pub }, { token: useInterface<IThing>(), useExisting: Pub }],
    });
    export const scopedChild = defineBuilderConfig({
      name: 'ScopedChild',
      useContainer: scopedParent,
      injections: [{ token: Local }, { token: useInterface<IThing>(), useExisting: Local, scoped: true }],
    });
    export const plainChild = defineBuilderConfig({
      name: 'PlainChild',
      useContainer: scopedParent,
      injections: [{ token: Local }, { token: useInterface<IThing>(), useExisting: Local }],
    });
  `],
  [PARTIAL, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    const thing = useInterface<IThing>();
    const aliasPartial = definePartialConfig({ expects: [Impl], injections: [{ token: thing, useExisting: Impl }] });
    const targetPartial = definePartialConfig({ injections: [{ token: Impl }] });
    export const partialEager = defineBuilderConfig({
      name: 'PartialEager',
      extends: [aliasPartial],
      optimization: { mode: 'closed', roots: [Impl], eager: [thing] },
      injections: [{ token: Impl }],
    });
    export const partialAlias = defineBuilderConfig({
      name: 'PartialAlias',
      extends: [aliasPartial],
      injections: [{ token: Impl }],
    });
    export const partialTarget = defineBuilderConfig({
      name: 'PartialTarget',
      extends: [targetPartial],
      injections: [{ token: thing, useExisting: Impl }],
    });
    export const targetEager = defineBuilderConfig({
      name: 'TargetEager',
      extends: [targetPartial],
      optimization: { mode: 'closed', roots: [Impl], eager: [Impl] },
      injections: [{ token: thing, useExisting: Impl }],
    });
  `],
  [USAGE, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    const thing = useInterface<IThing>();
    export const usageBox = defineBuilderConfig({
      name: 'Usage',
      optimization: { mode: 'closed', roots: [thing] },
      injections: [{ token: Impl }, { token: thing, useExisting: Impl }],
    });
    usageBox.resolve(thing);
    usageBox.resolve(Impl);
  `],
]);

/** Its own analyzer: a token the analyzer cannot name must not stop the analysis of the other files. */
const NO_NAME_FILES = new Map<string, string>([
  [TOKENS, files.get(TOKENS) ?? ''],
  [NONAME, `
    ${IMPORTS}
    class Impl implements IThing { id = 'impl'; }
    export const noTarget = defineBuilderConfig({
      name: 'NoTarget',
      injections: [{ token: Impl }, { token: useInterface<IThing>(), useExisting: 42 }],
    });
    export const noToken = defineBuilderConfig({
      name: 'NoToken',
      injections: [{ token: Impl }, { token: 42, useExisting: Impl }],
    });
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
  'NEO_CYCLE',
  'NEO_DISPOSABLE_TRANSIENT_CAPTURED',
  'NEO_DUPLICATE_PROVIDER',
  'NEO_MISSING_PROVIDER',
  'NEO_MULTI_REQUIRES_RESOLVE_ALL',
  'NEO_ROOT_NOT_EXPORTED',
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

/** Every error, with or without a stable code, as `code or type: message`. */
function everything(errors: readonly AnalysisError[]): string[] {
  return errors.map((error) => `${stableCodeOf(error) ?? error.type}: ${error.message}`);
}

/** `line:column` (1-based) of the `occurrence`-th `needle` of `file`. */
function at(file: string, needle: string, occurrence = 1): string {
  const lines = (files.get(file) ?? NO_NAME_FILES.get(file) ?? '').split('\n');
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

function graphNamed(analyzer: Analyzer, name: string): DependencyGraph {
  const graph = analyzer.extractAll().find((candidate) => candidate.containerName === name);
  if (!graph) throw new Error(`missing graph ${name}`);
  return graph;
}

/** The type of the registration of the token whose id starts with `name_`. */
function typeOf(graph: DependencyGraph, name: string): unknown {
  for (const [id, node] of graph.nodes) {
    if (id.startsWith(`${name}_`)) return Reflect.get(node.service, 'type');
  }
  return undefined;
}

describe('E20 useExisting diagnostics', () => {
  let analyzer: Analyzer;

  beforeAll(() => {
    analyzer = new Analyzer(createProgram(files));
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('E20-P0 an alias is a registration of type alias that satisfies its consumer', () => {
    expect(typeOf(graphNamed(analyzer, 'Ok'), 'IThing'), 'the graph has an alias node').toBe('alias');
    expect(everything(analyzer.extractForFile(OK).errors)).toEqual([]);
  });

  it('E20-P13 a target assignable to the type of the alias token is accepted, a subtype too', () => {
    expect(typeOf(graphNamed(analyzer, 'Subtype'), 'IThing'), 'the graph has an alias node').toBe('alias');
    expect(everything(analyzer.extractForFile(SUBTYPE).errors)).toEqual([]);
  });

  it('E20-P13 a target that is not assignable to the type of the alias token is a type-mismatch at the registration', () => {
    const errors = analyzer.extractForFile(WRONG).errors;
    expect(typeOf(graphNamed(analyzer, 'Wrong'), 'IOther'), 'the graph has an alias node').toBe('alias');
    expect(errors.map((error) => error.type)).toEqual(['type-mismatch']);
    const [error] = errors;
    const position = error?.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
    expect(`${(position?.line ?? 0) + 1}:${(position?.character ?? 0) + 1}`).toBe(at(WRONG, '{ token: useInterface<IOther>()'));
    expect(error?.message).toContain("'Impl' is not assignable to token type 'IOther'");
    // The build reads the graph: the same refusal, with the same text.
    const fromGraph = graphNamed(analyzer, 'Wrong').errors?.map((item) => item.message);
    expect(fromGraph).toEqual([error?.message]);
  });

  it('E20-P14 a target no container provides is NEO_MISSING_PROVIDER at the token of the alias', () => {
    expect(found(analyzer.extractForFile(MISSING).errors)).toEqual([
      `NEO_MISSING_PROVIDER ${at(MISSING, 'token: thing')} token: thing`,
    ]);
    expect(typeOf(graphNamed(analyzer, 'Missing'), 'IThing'), 'it is still an alias').toBe('alias');
  });

  it('E20-P15 aliases that point at each other are one NEO_CYCLE, the same for the diagnostics and the graph', () => {
    const errors = analyzer.extractForFile(CYCLE).errors.filter((error) => stableCodeOf(error) === 'NEO_CYCLE');
    expect(errors, 'one cycle').toHaveLength(1);
    expect(errors[0]?.message).toMatch(/^Circular dependency detected: (IThing -> IPeer -> IThing|IPeer -> IThing -> IPeer)$/);
    const graph = graphNamed(analyzer, 'Cycle');
    expect(() => containerIROf(graph, ROOT), 'the IR of a graph that has a cycle of aliases is still written').not.toThrow();
    const cycles = new GraphValidator().validateAll(graph).errors.filter((error) => error.code === 'NEO_CYCLE');
    expect(cycles.map((error) => error.message)).toEqual(errors.map((error) => error.message));
  });

  it('E20-P15 a service that reads an alias of itself is a cycle through the alias', () => {
    const errors = analyzer.extractForFile(MIXED).errors.filter((error) => stableCodeOf(error) === 'NEO_CYCLE');
    expect(errors, 'one cycle').toHaveLength(1);
    expect(errors[0]?.message).toMatch(/Svc/);
    expect(errors[0]?.message).toMatch(/IThing/);
    const cycles = new GraphValidator().validateAll(graphNamed(analyzer, 'Mixed')).errors.filter((error) => error.code === 'NEO_CYCLE');
    expect(cycles.map((error) => error.message)).toEqual(errors.map((error) => error.message));
  });

  it('E20-P16 what an alias cannot carry is NEO_CONFIG_UNSUPPORTED at the registration, a multi target keeps its own code', () => {
    const all = found(analyzer.extractForFile(REFUSE).errors);
    const line = (needle: string, occurrence = 1): string => at(REFUSE, needle, occurrence);
    expect(all).toEqual([
      `NEO_CONFIG_UNSUPPORTED ${line('{ token: thing, useExisting: Impl, multi: true }')} { token: thing, useExisting: Impl, multi: true }`,
      `NEO_MULTI_REQUIRES_RESOLVE_ALL ${line('token: thing', 2)} token: thing`,
      `NEO_CONFIG_UNSUPPORTED ${line('{ token: thing, useExisting: Impl, provider: Impl }')} { token: thing, useExisting: Impl, provider: Impl }`,
      `NEO_CONFIG_UNSUPPORTED ${line('{ token: thing, useExisting: Impl, useFactory: true')} { token: thing, useExisting: Impl, useFactory: true, provider: () => new Impl() }`,
      `NEO_CONFIG_UNSUPPORTED ${line('{ token: thing, useExisting: Impl, useValue')} { token: thing, useExisting: Impl, useValue: { id: 'v' } }`,
      `NEO_CONFIG_UNSUPPORTED ${line("{ token: thing, useExisting: Impl, lifecycle")} { token: thing, useExisting: Impl, lifecycle: 'transient' }`,
      `NEO_CONFIG_UNSUPPORTED ${line("{ token: thing, useExisting: Impl, ownership")} { token: thing, useExisting: Impl, ownership: 'borrowed' }`,
      `NEO_CONFIG_UNSUPPORTED ${line('{ token: thing, useExisting: Impl, dependencies')} { token: thing, useExisting: Impl, dependencies: [] }`,
      `NEO_CONFIG_UNSUPPORTED ${line("{ token: useProperty<number>(Holder, 'x'), useExisting: Impl }")} { token: useProperty<number>(Holder, 'x'), useExisting: Impl }`,
      `NEO_CONFIG_UNSUPPORTED ${line('thing] },')} thing`,
    ]);
  });

  it('E20-W8 an alias of a multi token is refused by the build graph too, with the same code', () => {
    const graph = graphNamed(analyzer, 'R2');
    const codes = (graph.errors ?? []).map((error) => stableCodeOf(error));
    expect(codes, 'the graph the build reads refuses it').toEqual(['NEO_MULTI_REQUIRES_RESOLVE_ALL']);
    const [error] = graph.errors ?? [];
    const position = error?.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
    expect(`${(position?.line ?? 0) + 1}:${(position?.character ?? 0) + 1}`, 'at the token of the alias').toBe(at(REFUSE, 'token: thing', 2));
  });

  it('E20-P16 the messages say what to do', () => {
    const messages = analyzer.extractForFile(REFUSE).errors.map((error) => error.message);
    expect(messages.find((message) => message.includes('eager')) ?? '', 'the eager message').toContain('list the target');
    expect(messages.some((message) => /an alias cannot be multi.*resolveAll/.test(message)), 'multi alias').toBe(true);
    expect(messages.some((message) => /alias.*property/i.test(message)), 'property token alias').toBe(true);
  });

  it('E20-P16 `scoped` is allowed on an alias', () => {
    const errors = found(analyzer.extractForFile(REFUSE).errors);
    expect(errors.some((error) => error.includes('scoped: true'))).toBe(false);
    expect(typeOf(graphNamed(analyzer, 'R11'), 'IThing'), 'the alias with scoped is a registration').toBe('alias');
  });

  it('E20-P17 an alias registered twice, an alias and a registration of the token, and an alias of a scope input are duplicates', () => {
    expect(typeOf(graphNamed(analyzer, 'D1'), 'IThing'), 'the graph has an alias node').toBe('alias');
    expect(found(analyzer.extractForFile(DUPLICATE).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, 'token: thing', 2)} token: thing`,
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, 'token: thing', 4)} token: thing`,
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, '{ token: thing, useExisting: Impl }', 4)} { token: thing, useExisting: Impl }`,
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, "{ token: thing, useValue: { id: 'many' }, multi: true }")} { token: thing, useValue: { id: 'many' }, multi: true }`,
      `NEO_DUPLICATE_PROVIDER ${at(DUPLICATE, '{ token: thing, useExisting: Impl }', 6)} { token: thing, useExisting: Impl }`,
    ]);
  });

  it('E20-W11 the graph the build reads refuses the same duplicates, and a token that is an alias and a multi token', () => {
    expect(typeOf(graphNamed(analyzer, 'D4'), 'IThing'), 'the graph has an alias node').toBe('alias');
    const duplicate = graphNamed(analyzer, 'D1').errors?.map((error) => error.message) ?? [];
    expect(duplicate, 'an alias twice').toEqual([expect.stringContaining('already registered')]);
    const mixed = graphNamed(analyzer, 'D4').errors?.map((error) => error.message) ?? [];
    expect(mixed, 'an alias and a multi registration').toEqual([expect.stringContaining("both with and without 'multi: true'")]);
    const reversed = graphNamed(analyzer, 'D5').errors?.map((error) => error.message) ?? [];
    expect(reversed, 'a multi registration and an alias, in that order').toEqual([expect.stringContaining("both with and without 'multi: true'")]);
  });

  it('E20-P18 a singleton that reads a disposable transient through an alias is refused, the alias alone is not', () => {
    expect(found(analyzer.extractForFile(CAPTURE).errors)).toEqual([
      `NEO_DISPOSABLE_TRANSIENT_CAPTURED ${at(CAPTURE, '{ token: Cache }')} { token: Cache }`,
    ]);
    expect(found(analyzer.extractForFile(TRANSIENT).errors), 'a transient consumer and the alias itself are not captors').toEqual([]);
    expect(typeOf(graphNamed(analyzer, 'Transient'), 'IThing'), 'the alias exists').toBe('alias');
  });

  it('E20-P19 a published alias keeps its target, a graph with no root prunes both, and the IR keeps the link', () => {
    const closed = graphNamed(analyzer, 'ClosedAlias');
    expect(typeOf(closed, 'IThing'), 'the alias exists').toBe('alias');
    const reasons = [...(closed.retention?.values() ?? [])].map((reason) => reason.kind).sort();
    expect(reasons, 'the alias is a root, the target is retained through it, nothing is unreachable').toEqual(['dependency-of', 'root']);
    const ir = containerIROf(closed, ROOT);
    const alias = ir.registrations.find((registration) => registration.token.startsWith('IThing_'));
    expect(Reflect.get(alias?.provider ?? {}, 'kind'), 'the IR has a provider of kind alias').toBe('alias');
    expect(alias?.dependencies.map((dependency) => dependency.kind), 'one local reference to the target').toEqual(['local']);
    expect(alias?.lifecycle).toBe('singleton');
    const pruned = graphNamed(analyzer, 'Pruned');
    const kinds = [...(pruned.retention?.values() ?? [])].map((reason) => reason.kind).sort();
    expect(kinds, 'with another root, the alias and its target are both unreachable').toEqual(['root', 'unreachable', 'unreachable']);
  });

  it('E20-W9 the IR of an alias shows the lifecycle and the owner of its target, and singleton and borrowed for a parent token', () => {
    const transient = containerIROf(graphNamed(analyzer, 'Transient'), ROOT);
    const ofTransient = transient.registrations.find((registration) => registration.token.startsWith('IThing_'));
    expect(Reflect.get(ofTransient?.provider ?? {}, 'kind'), 'an alias of a local transient').toBe('alias');
    expect([ofTransient?.lifecycle, ofTransient?.ownership], 'it is the transient of its target, owned by its caller').toEqual(['transient', 'caller']);
    const child = containerIROf(graphNamed(analyzer, 'Child'), ROOT);
    const ofParent = child.registrations.find((registration) => registration.token.startsWith('IThing_'));
    expect([ofParent?.lifecycle, ofParent?.ownership, ofParent?.dependencies.map((dependency) => dependency.kind)], 'an alias of a parent token').toEqual(['singleton', 'borrowed', ['parent']]);
  });

  it('E20-W10 an alias with scoped replaces the token of its parent, an alias without it is a duplicate', () => {
    expect(typeOf(graphNamed(analyzer, 'ScopedChild'), 'IThing'), 'the scoped alias is an alias').toBe('alias');
    expect(found(analyzer.extractForFile(SCOPED).errors)).toEqual([
      `NEO_DUPLICATE_PROVIDER ${at(SCOPED, 'token: useInterface<IThing>()', 3)} token: useInterface<IThing>()`,
    ]);
  });

  it('E20-P7 a child alias of what a closed parent hides is NEO_MISSING_PROVIDER, an alias of its root is accepted', () => {
    expect(typeOf(graphNamed(analyzer, 'Child'), 'IThing'), 'the child has the alias').toBe('alias');
    expect(found(analyzer.extractForFile(PARENT).errors)).toEqual([
      `NEO_MISSING_PROVIDER ${at(PARENT, 'token: useInterface<IPeer>(), useExisting: Priv')} token: useInterface<IPeer>()`,
    ]);
  });

  it('E20-P6 in a closed container, a published alias is a root and its private target is flagged at a resolve call', () => {
    expect(typeOf(graphNamed(analyzer, 'Usage'), 'IThing'), 'the alias exists').toBe('alias');
    expect(found(analyzer.extractForFile(USAGE).errors)).toEqual([
      `NEO_ROOT_NOT_EXPORTED ${at(USAGE, 'usageBox.resolve(Impl)')} usageBox.resolve(Impl)`,
    ]);
  });
  it('E20-F5 a useExisting that names no token is NEO_CONFIG_UNSUPPORTED at the registration, on either side', () => {
    let errors: readonly AnalysisError[] = [];
    let crashed: unknown;
    try {
      errors = new Analyzer(createProgram(NO_NAME_FILES)).extractForFile(NONAME).errors;
    } catch (error) {
      crashed = error;
    }
    expect(crashed, 'the analyzer reports a registration that names no token, it does not throw').toBeUndefined();
    expect(found(errors), 'the target and the token are each refused at their registration').toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(NONAME, '{ token: useInterface<IThing>(), useExisting: 42 }')} { token: useInterface<IThing>(), useExisting: 42 }`,
      `NEO_CONFIG_UNSUPPORTED ${at(NONAME, '{ token: 42, useExisting: Impl }')} { token: 42, useExisting: Impl }`,
    ]);
    expect(errors.every((error) => error.message.includes('useExisting must name a token')), 'the message says what to write').toBe(true);
  });

  it('E20-F9 an alias folded in from a partial is refused as an eager root, and an alias or a target in a partial works', () => {
    expect(found(analyzer.extractForFile(PARTIAL).errors), 'only the alias listed in eager is refused').toEqual([
      `NEO_CONFIG_UNSUPPORTED ${at(PARTIAL, 'thing] },')} thing`,
    ]);
    const messages = analyzer.extractForFile(PARTIAL).errors.map((error) => error.message);
    expect(messages.find((message) => message.includes('eager')) ?? '', 'with the message of the eager alias').toContain('list the target');
    expect(typeOf(graphNamed(analyzer, 'PartialAlias'), 'IThing'), 'an alias of a partial is an alias of the host').toBe('alias');
    expect(typeOf(graphNamed(analyzer, 'PartialTarget'), 'IThing'), 'an alias of the host reads a target of a partial').toBe('alias');
    expect(graphNamed(analyzer, 'PartialTarget').errors ?? [], 'and the target is found').toEqual([]);
  });
});

