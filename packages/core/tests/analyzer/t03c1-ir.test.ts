import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { assertLocalReferences, containerIROf, type ContainerIR } from '../../src/analyzer/ir';
import { TSContext } from '../../src/TSContext';
import { CORPUS, fixtureFiles } from '../helpers/t03c1-corpus';
import { DUMP_ROOT } from '../helpers/t03c1-dump';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

function irOf(files: ReadonlyMap<string, string>, containerName: string): ContainerIR {
  return TSContext.runWithProjectRoot(DUMP_ROOT, () => {
    const graph = new Analyzer(memoryProgram(files)).extractAll().find((item) => item.containerName === containerName);
    if (!graph) throw new Error(`missing graph ${containerName}`);
    return containerIROf(graph, DUMP_ROOT);
  });
}

function corpusFiles(name: string): ReadonlyMap<string, string> {
  const fixture = CORPUS.find((entry) => entry.name === name);
  if (!fixture) throw new Error(`no fixture ${name}`);
  return fixtureFiles(fixture);
}

const HEADER = "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';";

describe('T03 C1 the IR names the parent of a token and keeps a dependency nobody provides', () => {
  it('W18 a token a declareContainerTokens parent provides names that container, not an empty string', () => {
    const ir = irOf(corpusFiles('parent-declare-tokens'), 'Modern');
    const newer = ir.registrations.find((item) => item.token.startsWith('Newer'));
    expect(newer?.dependencies).toHaveLength(1);
    const [dependency] = newer?.dependencies ?? [];
    expect(dependency).toMatchObject({ kind: 'parent', parent: 'declared:legacyBox' });
    expect(dependency?.kind === 'parent' ? dependency.token.split('_')[0] : '').toBe('Old');
  });

  it('W18 a token a NeoSyringe parent provides still names the key of that parent', () => {
    const ir = irOf(corpusFiles('parent-open'), 'OpenKid');
    const parents = ir.registrations.flatMap((item) => item.dependencies).filter((ref) => ref.kind === 'parent');
    expect(parents.length).toBeGreaterThan(0);
    for (const ref of parents) {
      expect(ref.kind === 'parent' ? ref.parent : '').toMatch(/OpenParent|[0-9a-f]{6,}/);
      expect(ref.kind === 'parent' ? ref.parent : '').not.toBe('');
    }
  });

  it('W18 a dependency that nobody provides stays in the IR as an unresolved reference', () => {
    const file = captureRoot('ir/app.ts');
    const source = [
      HEADER,
      'class Dep {}',
      'class Needs { constructor(public dep: Dep) {} }',
      "export const app = defineBuilderConfig({ name: 'IrUnresolved', injections: [{ token: Needs }] });",
      '',
    ].join('\n');
    const ir = irOf(new Map([[file, source]]), 'IrUnresolved');
    const [needs] = ir.registrations;
    expect(needs?.dependencies).toHaveLength(1);
    const [dependency] = needs?.dependencies ?? [];
    expect(dependency?.kind).toBe('unresolved');
    expect(dependency?.kind === 'unresolved' ? dependency.token.split('_')[0] : '').toBe('Dep');
    expect(dependency?.kind === 'unresolved' ? dependency.optional : undefined).toBe(false);
    expect(() => assertLocalReferences(ir)).not.toThrow();
  });

  it('W18 an optional dependency nobody provides is unresolved and optional', () => {
    const ir = irOf(corpusFiles('optional-deps'), 'OptApp');
    const needs = ir.registrations.find((item) => item.token.startsWith('Needs'));
    const refs = needs?.dependencies ?? [];
    // `a?: Present` is provided; `b: Absent | undefined` and `c = 5` have a default or are optional.
    expect(refs.map((ref) => ref.kind)).toEqual(['local', 'unresolved', 'unresolved']);
    expect(refs.map((ref) => (ref.kind === 'unresolved' ? ref.optional : undefined))).toEqual([undefined, true, true]);
  });
});
