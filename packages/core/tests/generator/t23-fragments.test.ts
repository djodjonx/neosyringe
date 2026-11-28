import { describe, expect, it } from 'vitest';
import {
  NamePool,
  concat,
  fragment,
  generatedText,
  linkHelpers,
  render,
  selectHelpers,
  snapshotOfFiles,
  withNeeds,
  type Fragment,
  type Helper,
  type HelperId,
  type Part,
  type Snapshot,
} from '../../src/generator/fragments';

function helper(id: HelperId, text: string, needs: HelperId[] = []): Helper {
  return { id, parts: [generatedText(text)], needs };
}

function root(text: string, needs: HelperId[] = []): Fragment {
  return { parts: [generatedText(text)], needs };
}

function textOf(parts: readonly Part[]): string {
  return parts.map((part) => (part.kind === 'generated' ? part.text : `<${part.file}:${part.start}+${part.length}>`)).join('');
}

function sourcePart(snapshot: string, file: string, start: number, length: number): Part {
  return { kind: 'source', snapshot, file, start, length };
}

function snapshotOf(id: string, files: Record<string, string>): Snapshot {
  return { id, files: new Map(Object.entries(files)) };
}

describe('T23 linkHelpers (P2)', () => {
  it('T23-P2 pulls the helpers a helper needs, transitively', () => {
    const catalog = [helper('resolveSingle', 'S;', ['resolveAll']), helper('resolveAll', 'A;')];
    const linked = linkHelpers([root('R;', ['resolveSingle'])], catalog);
    expect(textOf(linked)).toBe('S;A;R;');
  });

  it('T23-P2 declares each helper once, in catalog order', () => {
    const catalog = [helper('resolveSingle', 'S;'), helper('resolveAll', 'A;')];
    const roots = [root('R1;', ['resolveAll', 'resolveSingle']), root('R2;', ['resolveAll'])];
    expect(textOf(linkHelpers(roots, catalog))).toBe('S;A;R1;R2;');
  });

  it('T23-P2 declares no helper nobody needs', () => {
    const catalog = [helper('resolveSingle', 'S;'), helper('resolveAll', 'A;')];
    expect(textOf(linkHelpers([root('R;')], catalog))).toBe('R;');
  });

  it('T23-P2 a missing helper is an error that names it', () => {
    expect(() => linkHelpers([root('R;', ['resolveAll'])], [helper('resolveSingle', 'S;')]))
      .toThrow('missing helper: resolveAll');
  });

  it('T23-P2 a duplicate helper is an error', () => {
    const catalog = [helper('resolveSingle', 'S;'), helper('resolveSingle', 'S2;')];
    expect(() => linkHelpers([root('R;', ['resolveSingle'])], catalog)).toThrow('duplicate helper');
  });

  it('T23-P2 a helper cycle terminates and declares both helpers once', () => {
    const catalog = [helper('resolveSingle', 'S;', ['resolveAll']), helper('resolveAll', 'A;', ['resolveSingle'])];
    expect(textOf(linkHelpers([root('R;', ['resolveAll'])], catalog))).toBe('S;A;R;');
  });

  it('T23-P10 selectHelpers lists the needed helpers in catalog order and nothing else', () => {
    const catalog = [helper('resolveSingle', 'S;'), helper('resolveAll', 'A;')];
    expect(selectHelpers([root('R;', ['resolveAll'])], catalog).map((item) => item.id)).toEqual(['resolveAll']);
    expect(selectHelpers([root('R;', ['resolveAll', 'resolveSingle'])], catalog).map((item) => item.id))
      .toEqual(['resolveSingle', 'resolveAll']);
    expect(selectHelpers([root('R;')], catalog)).toEqual([]);
  });
});

describe('T23 render (P3)', () => {
  const snapshot = snapshotOf('s1', { '/a.ts': 'const answer = 42;' });

  it('T23-P3 refuses a part cut from another snapshot', () => {
    expect(() => render([sourcePart('s0', '/a.ts', 0, 5)], snapshot)).toThrow('stale source snapshot');
  });

  it('T23-P3 refuses a file the snapshot does not hold', () => {
    expect(() => render([sourcePart('s1', '/missing.ts', 0, 1)], snapshot)).toThrow('missing source file');
  });

  it.each([
    ['a negative start', -1, 1],
    ['a negative length', 0, -1],
    ['a start past the end', 19, 0],
    ['a range that ends past the end', 10, 9],
    ['a fractional start', 1.5, 1],
    ['a fractional length', 1, 1.5],
    ['a start that is not a number', Number.NaN, 1],
  ])('T23-P3 refuses %s', (_label, start, length) => {
    expect(() => render([sourcePart('s1', '/a.ts', start, length)], snapshot)).toThrow('invalid source range');
  });

  it('T23-P3 accepts an empty range at the end and a range that fills the file', () => {
    const size = 'const answer = 42;'.length;
    expect(render([sourcePart('s1', '/a.ts', size, 0)], snapshot).code).toBe('');
    expect(render([sourcePart('s1', '/a.ts', 0, size)], snapshot).code).toBe('const answer = 42;');
  });

  it('T23-P3 reports each copy in UTF-16 units, after an emoji and across CRLF lines', () => {
    const text = "const label = '😀';\r\nconst run = () => 1;\r\n";
    const start = text.indexOf('() => 1');
    const length = '() => 1'.length;
    const emoji = text.indexOf('😀');
    const rendered = render(
      [
        generatedText('x = '),
        sourcePart('s1', '/b.ts', start, length),
        generatedText('; /* 😀 */ y = '),
        sourcePart('s1', '/b.ts', emoji, 2),
      ],
      snapshotOf('s1', { '/b.ts': text }),
    );
    expect(rendered.code).toBe('x = () => 1; /* 😀 */ y = 😀');
    const secondStart = 'x = () => 1; /* 😀 */ y = '.length;
    expect(rendered.copies).toEqual([
      { generatedStart: 4, sourceFile: '/b.ts', sourceStart: start, length },
      { generatedStart: secondStart, sourceFile: '/b.ts', sourceStart: emoji, length: 2 },
    ]);
    for (const copy of rendered.copies) {
      expect(rendered.code.slice(copy.generatedStart, copy.generatedStart + copy.length))
        .toBe(text.slice(copy.sourceStart, copy.sourceStart + copy.length));
    }
  });

  it('T23-P3 reports one copy per use of the same source text', () => {
    const rendered = render(
      [sourcePart('s1', '/a.ts', 6, 6), generatedText('|'), sourcePart('s1', '/a.ts', 6, 6)],
      snapshot,
    );
    expect(rendered.code).toBe('answer|answer');
    expect(rendered.copies.map((copy) => copy.generatedStart)).toEqual([0, 7]);
    expect(rendered.copies.map((copy) => copy.sourceStart)).toEqual([6, 6]);
  });
});

describe('T23 fragment builders (P10)', () => {
  it('T23-P10 fragment joins text, parts and fragments, and merges the needs', () => {
    const copy = sourcePart('s1', '/a.ts', 1, 2);
    const inner = root('inner', ['resolveAll']);
    const built = fragment`a${'b'}${copy}c${inner}d${root('e', ['resolveSingle', 'resolveAll'])}`;
    expect(textOf(built.parts)).toBe('ab</a.ts:1+2>cinnerde');
    expect(built.needs).toEqual(['resolveAll', 'resolveSingle']);
  });

  it('T23-P10 fragment merges neighbouring generated text and keeps source parts apart', () => {
    const built = fragment`a${'b'}${generatedText('c')}`;
    expect(built.parts).toEqual([{ kind: 'generated', text: 'abc' }]);
    const split = fragment`a${sourcePart('s1', '/a.ts', 0, 1)}b`;
    expect(split.parts.map((part) => part.kind)).toEqual(['generated', 'source', 'generated']);
  });

  it('T23-P10 fragment leaves no empty generated part around a source part', () => {
    const only = fragment`${sourcePart('s1', '/a.ts', 0, 1)}`;
    expect(only.parts).toEqual([sourcePart('s1', '/a.ts', 0, 1)]);
  });

  it('T23-P10 withNeeds adds needs once and keeps the parts', () => {
    const base = root('x', ['resolveAll']);
    const more = withNeeds(base, ['resolveAll', 'resolveSingle']);
    expect(more.parts).toEqual(base.parts);
    expect(more.needs).toEqual(['resolveAll', 'resolveSingle']);
    expect(base.needs).toEqual(['resolveAll']);
  });

  it('T23-P10 concat joins pieces with a separator and merges the needs', () => {
    const joined = concat([root('x', ['resolveAll']), 'y', root('z', ['resolveSingle'])], ', ');
    expect(textOf(joined.parts)).toBe('x, y, z');
    expect(joined.needs).toEqual(['resolveAll', 'resolveSingle']);
    expect(concat([], ', ')).toEqual({ parts: [], needs: [] });
  });

  it('T23-P10 generatedText is a generated part', () => {
    expect(generatedText('hi')).toEqual({ kind: 'generated', text: 'hi' });
  });
});

describe('T23 NamePool (P4)', () => {
  it('T23-P4 never returns a reserved binding', () => {
    const pool = new NamePool(['__neo_0', '__neo_1']);
    expect(pool.forKey('first')).toBe('__neo_2');
    expect(pool.forKey('second')).toBe('__neo_3');
  });

  it('T23-P4 gives the same key the same name', () => {
    const pool = new NamePool([]);
    const first = pool.forKey('first');
    expect(pool.forKey('other')).not.toBe(first);
    expect(pool.forKey('first')).toBe(first);
  });

  it('T23-P4 keeps the preferred name while it is free and suffixes it on a collision only', () => {
    const pool = new NamePool(['taken']);
    expect(pool.forKey('a', 'Import_0')).toBe('Import_0');
    expect(pool.forKey('b', 'Import_0')).toBe('Import_0_1');
    expect(pool.forKey('c', 'Import_0')).toBe('Import_0_2');
    expect(pool.forKey('d', 'taken')).toBe('taken_1');
    expect(pool.forKey('a', 'Other')).toBe('Import_0');
  });

  it('T23-P4 never hands a later key a name that an earlier suffix took', () => {
    const pool = new NamePool([]);
    expect(pool.forKey('a', 'n')).toBe('n');
    expect(pool.forKey('b', 'n')).toBe('n_1');
    expect(pool.forKey('c', 'n_1')).toBe('n_1_1');
  });

  it('T23-P9 two pools with the same input give the same names, whatever ran before', () => {
    const run = (): string[] => {
      const pool = new NamePool(['__neo_1']);
      return [pool.forKey('a'), pool.forKey('b'), pool.forKey('c', 'Import_0'), pool.forKey('d', 'Import_0')];
    };
    const first = run();
    new NamePool([]).forKey('noise');
    expect(run()).toEqual(first);
    expect(first).toEqual(['__neo_0', '__neo_2', 'Import_0', 'Import_0_1']);
  });
});

describe('T23 a snapshot is named by what it holds (R5)', () => {
  const held = (entries: Array<[string, string]>): Snapshot => snapshotOfFiles(new Map(entries));

  it('T23-R5 the same files give the same id, whatever the order they were read in', () => {
    const one = held([['/a.ts', 'const a = 1;'], ['/b.ts', 'const b = 2;']]);
    const other = held([['/b.ts', 'const b = 2;'], ['/a.ts', 'const a = 1;']]);
    expect(other.id).toBe(one.id);
  });

  it('T23-R5 another text for a file gives another id', () => {
    expect(held([['/a.ts', 'const a = 1;']]).id).not.toBe(held([['/a.ts', 'const a = 2;']]).id);
  });

  it('T23-R5 another file name gives another id', () => {
    expect(held([['/a.ts', 'x']]).id).not.toBe(held([['/b.ts', 'x']]).id);
  });

  it('T23-R5 the id holds neither a path nor a source text', () => {
    const { id } = held([['/Users/someone/project/a.ts', 'const secret = 1;']]);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('T23-R5 a part cut from the snapshot of another analysis is refused', () => {
    const before = held([['/a.ts', 'const answer = 42;']]);
    const after = held([['/a.ts', 'const answer = 43;']]);
    const part = sourcePart(before.id, '/a.ts', 0, 5);
    expect(render([part], before).code).toBe('const');
    expect(() => render([part], after)).toThrow('stale source snapshot');
  });

  it('T23-R5 the snapshot keeps the files it was given', () => {
    const files = new Map([['/a.ts', 'const a = 1;']]);
    expect(snapshotOfFiles(files).files.get('/a.ts')).toBe('const a = 1;');
  });
});
