import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FILE = captureRoot('closed-parent/app.ts');

const HEADER = [
  "import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';",
  'export class Secret {}',
  'export class Shown {}',
  'export class NeedsSecret { constructor(public secret: Secret) {} }',
  'export class NeedsShown { constructor(public shown: Shown) {} }',
].join('\n');

function fixture(...blocks: string[]): ReadonlyMap<string, string> {
  return new Map([[FILE, `${HEADER}\n${blocks.join('\n')}\n`]]);
}

const CLOSED_PARENT =
  "export const parent = defineBuilderConfig({ name: 'ClosedP', optimization: { mode: 'closed', roots: [Shown] }, injections: [{ token: Shown }, { token: Secret }] });";

const READS_SECRET = fixture(
  CLOSED_PARENT,
  "export const child = defineBuilderConfig({ name: 'ClosedC', useContainer: parent, injections: [{ token: NeedsSecret }] });",
);

const READS_SHOWN = fixture(
  CLOSED_PARENT,
  "export const child = defineBuilderConfig({ name: 'ClosedC', useContainer: parent, injections: [{ token: NeedsShown }] });",
);

const REGISTERS_SECRET = fixture(
  CLOSED_PARENT,
  "export const child = defineBuilderConfig({ name: 'ClosedC', useContainer: parent, injections: [{ token: Secret }] });",
);

const GRANDPARENT = fixture(
  'export class Far {}',
  'export class NeedsFar { constructor(public far: Far) {} }',
  "export const grand = defineBuilderConfig({ name: 'Grand', injections: [{ token: Far }] });",
  "export const middle = defineBuilderConfig({ name: 'ClosedMiddle', useContainer: grand, optimization: { mode: 'closed', roots: [Shown] }, injections: [{ token: Shown }] });",
  "export const child = defineBuilderConfig({ name: 'Leaf', useContainer: middle, injections: [{ token: NeedsFar }] });",
);

const PARTIAL_ROOT = fixture(
  'export const part = definePartialConfig({ injections: [{ token: Shown }, { token: Secret }] });',
  "export const parent = defineBuilderConfig({ name: 'ClosedPart', extends: [part], optimization: { mode: 'closed', roots: [Shown] }, injections: [] });",
  "export const kidShown = defineBuilderConfig({ name: 'KidShown', useContainer: parent, injections: [{ token: NeedsShown }] });",
  "export const kidSecret = defineBuilderConfig({ name: 'KidSecret', useContainer: parent, injections: [{ token: NeedsSecret }] });",
);

function codes(files: ReadonlyMap<string, string>): { all: (string | undefined)[]; forFile: (string | undefined)[] } {
  const analyzer = new Analyzer(memoryProgram(files));
  return {
    all: analyzer.extractAllErrors().map((error) => error.code ?? error.type),
    forFile: analyzer.extractForFile(FILE).errors.map((error) => error.code ?? error.type),
  };
}

describe('T03 C1 a closed parent offers its exported roots to the child, nothing else', () => {
  it('W10 a token the closed parent keeps private is missing in the child', () => {
    const analyzer = new Analyzer(memoryProgram(READS_SECRET));
    const errors = analyzer.extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Secret'");
    expect(analyzer.extractForFile(FILE).errors).toEqual(errors);
  });

  it('W10 the build path refuses the same use, so the snapshot and GraphValidator agree', () => {
    const graphs = new Analyzer(memoryProgram(READS_SECRET)).extractAll();
    const child = graphs.find((graph) => graph.containerName === 'ClosedC');
    if (!child) throw new Error('missing graph ClosedC');
    const refused = new GraphValidator().validateAll(child).errors.map((error) => error.code);
    expect(refused).toEqual(['NEO_MISSING_PROVIDER']);
  });

  it('W10 an exported root of the closed parent is still available', () => {
    expect(codes(READS_SHOWN)).toEqual({ all: [], forFile: [] });
  });

  it('W10 a child may register a token the closed parent keeps private', () => {
    expect(codes(REGISTERS_SECRET)).toEqual({ all: [], forFile: [] });
  });

  it('W10 a closed parent does not hand on the tokens of its own parent', () => {
    const errors = new Analyzer(memoryProgram(GRANDPARENT)).extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Far'");
  });

  it('W10 a root exported from a partial of the closed parent is available, the private one is not', () => {
    const errors = new Analyzer(memoryProgram(PARTIAL_ROOT)).extractAllErrors();
    expect(errors.map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(errors[0]?.message).toContain("Missing injection: 'Secret'");
  });
});
