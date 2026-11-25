import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { TSContext } from '../../src/TSContext';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const FIRST = captureRoot('first.ts');
const SECOND = captureRoot('second.ts');

const HEADER = "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';";

/** A registered class whose constructor needs a token nobody registers: one missing-provider error. */
function brokenContainer(label: string): string {
  return [
    HEADER,
    `export class Dep${label} {}`,
    `export class Needs${label} { constructor(public dep: Dep${label}) {} }`,
    `export const container${label} = defineBuilderConfig({`,
    `  name: 'Snapshot${label}',`,
    `  injections: [{ token: Needs${label} }],`,
    '});',
    '',
  ].join('\n');
}

function twoFiles(): Map<string, string> {
  return new Map([
    [FIRST, brokenContainer('One')],
    [SECOND, brokenContainer('Two')],
  ]);
}

describe('T03 C1 one snapshot per Program', () => {
  it('P1 two Analyzers on one Program share graphs and errors', () => {
    const program = memoryProgram(twoFiles());
    const left = new Analyzer(program);
    const right = new Analyzer(program);

    const leftGraphs = left.extractAll();
    const rightGraphs = right.extractAll();
    expect(leftGraphs).toHaveLength(2);
    expect(rightGraphs[0]).toBe(leftGraphs[0]);
    expect(rightGraphs[1]).toBe(leftGraphs[1]);

    const leftErrors = left.extractAllErrors();
    const rightErrors = right.extractAllErrors();
    expect(leftErrors.length).toBeGreaterThan(0);
    expect(rightErrors).toHaveLength(leftErrors.length);
    rightErrors.forEach((error, index) => expect(error).toBe(leftErrors[index]));

    expect(right.extractForFile(FIRST).configs).toBe(left.extractForFile(FIRST).configs);
  });

  it('P1 the two validation modes keep separate snapshots', () => {
    const program = memoryProgram(twoFiles());
    const strict = new Analyzer(program, { validation: 'strict' });
    const compatible = new Analyzer(program, { validation: 'compatible' });
    expect(compatible.extractAll()[0]).not.toBe(strict.extractAll()[0]);
    expect(new Analyzer(program, { validation: 'compatible' }).extractAll()[0]).toBe(compatible.extractAll()[0]);
  });

  it('P1 the snapshot is also keyed by the project root', () => {
    const program = memoryProgram(twoFiles());
    const here = new Analyzer(program).extractAll();
    const elsewhere = TSContext.runWithProjectRoot(captureRoot('other-root'), () => new Analyzer(program).extractAll());
    expect(elsewhere[0]).not.toBe(here[0]);
    expect(elsewhere[0]?.containerKey).not.toBe(here[0]?.containerKey);
    expect(new Analyzer(program).extractAll()[0]).toBe(here[0]);
  });

  it('P2 a rebuilt Program gives new graphs that reflect the edit and only its own AST', () => {
    const before = memoryProgram(twoFiles());
    const oldGraphs = new Analyzer(before).extractAll();
    const oldFirst = oldGraphs.find((graph) => graph.containerName === 'SnapshotOne');
    expect(oldFirst).toBeDefined();
    const oldTokens = [...(oldFirst?.nodes.keys() ?? [])];

    const edited = twoFiles();
    edited.set(FIRST, brokenContainer('One').replace(
      "injections: [{ token: NeedsOne }]",
      "injections: [{ token: NeedsOne }, { token: DepOne }]",
    ));
    const after = memoryProgram(edited, before);
    expect(after).not.toBe(before);

    const newGraphs = new Analyzer(after).extractAll();
    const newFirst = newGraphs.find((graph) => graph.containerName === 'SnapshotOne');
    expect(newFirst).not.toBe(oldFirst);
    expect(newFirst?.nodes.size).toBe(oldTokens.length + 1);
    expect(oldFirst?.nodes.size).toBe(oldTokens.length);
    expect(new Analyzer(after).extractAll()[0]).toBe(newGraphs[0]);
    expect(newGraphs[0]).not.toBe(oldGraphs[0]);

    for (const graph of newGraphs) {
      for (const node of graph.nodes.values()) {
        const file = node.service.registrationNode.getSourceFile();
        expect(after.getSourceFile(file.fileName)).toBe(file);
      }
    }
    expect(new Analyzer(after).extractForFile(FIRST).errors).toHaveLength(0);
    expect(new Analyzer(before).extractForFile(FIRST).errors.length).toBeGreaterThan(0);
  });

  it('P3 extractForFile returns the references listed by extractAllErrors', () => {
    const analyzer = new Analyzer(memoryProgram(twoFiles()));
    const all = analyzer.extractAllErrors();
    const first = analyzer.extractForFile(FIRST).errors;
    const second = analyzer.extractForFile(SECOND).errors;
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    for (const error of [...first, ...second]) expect(all).toContain(error);
    const again = analyzer.extractForFile(FIRST).errors;
    expect(again).toHaveLength(first.length);
    again.forEach((error, index) => expect(error).toBe(first[index]));
  });
});
