import { describe, expect, it } from 'vitest';
import * as search from '../../src/generator/cycleSearch';
import type { CycleMember } from '../../src/generator/cycleSearch';
import {
  exhaustiveCyclePaths,
  exhaustiveGroupCycles,
  multiCompleteMembers,
} from '../helpers/t03c1-cycle-oracle';

const COUNT = 60;

interface RetainedGroup {
  readonly first: readonly string[];
  readonly contributions: readonly string[];
}
interface Grouping {
  readonly reports: readonly { ids: string[] }[];
  readonly groups: readonly RetainedGroup[];
}
type CycleGroupsFn = (
  graph: ReadonlyMap<string, readonly string[]>,
  tokenOf: (id: string) => string,
  multiTokens: ReadonlySet<string>,
) => Grouping;

function groupingOf(): CycleGroupsFn {
  const candidate: unknown = (search as Record<string, unknown>).cycleGroups;
  expect(typeof candidate, 'cycleSearch exports the streaming cycleGroups').toBe('function');
  return candidate as CycleGroupsFn;
}

function tokenOfMembers(members: readonly CycleMember[]): (id: string) => string {
  const tokens = new Map(members.map((member) => [member.id, member.tokenId]));
  return (id) => tokens.get(id) ?? id;
}

describe('T03 C1 cycle search keeps one path per group', () => {
  it('P7 a complete multi digraph of 60 contributions keeps one path per group and per contribution', () => {
    const cycleGroups = groupingOf();
    const members = multiCompleteMembers(COUNT);
    const edges = search.cycleEdges(members);
    const base = exhaustiveCyclePaths(edges);
    // Base materializes one array per back edge: 60 self loops plus 1770 inner back edges.
    expect(base.length).toBe(COUNT + (COUNT * (COUNT - 1)) / 2);

    const grouping = cycleGroups(edges, tokenOfMembers(members), new Set(['Multi']));
    const retainedPaths = grouping.groups.length
      + grouping.groups.reduce((total, group) => total + group.contributions.length, 0);
    expect(grouping.groups.length).toBe(1);
    expect(retainedPaths).toBeLessThanOrEqual(COUNT + 1);
    expect(grouping.reports).toEqual(
      exhaustiveGroupCycles(base, tokenOfMembers(members), new Set(['Multi'])),
    );
    expect(grouping.reports).toHaveLength(COUNT);
  });

  it('P7 reports equal the exhaustive search on a ring, a self loop and two overlapping cycles', () => {
    const cycleGroups = groupingOf();
    const cases: CycleMember[][] = [
      [
        { id: 'a', tokenId: 'A', dependencies: ['B'] },
        { id: 'b', tokenId: 'B', dependencies: ['C'] },
        { id: 'c', tokenId: 'C', dependencies: ['A'] },
      ],
      [{ id: 'solo', tokenId: 'Solo', dependencies: ['Solo'] }],
      [
        { id: 'a', tokenId: 'A', dependencies: ['B', 'C'] },
        { id: 'b', tokenId: 'B', dependencies: ['A'] },
        { id: 'c', tokenId: 'C', dependencies: ['A', 'B'] },
      ],
      [
        { id: 'host', tokenId: 'Host', dependencies: ['Item'] },
        { id: 'i0', tokenId: 'Item', dependencies: ['Host'] },
        { id: 'i1', tokenId: 'Item', dependencies: ['Host'] },
      ],
    ];
    for (const members of cases) {
      const edges = search.cycleEdges(members);
      const tokenOf = tokenOfMembers(members);
      for (const multi of [new Set<string>(), new Set(['Item', 'Multi', 'Solo'])]) {
        const grouping = cycleGroups(edges, tokenOf, multi);
        expect(grouping.reports).toEqual(exhaustiveGroupCycles(exhaustiveCyclePaths(edges), tokenOf, multi));
      }
    }
  });

  it('P7 forEachCycle visits every back edge without handing out copies', () => {
    const forEachCycle: unknown = (search as Record<string, unknown>).forEachCycle;
    expect(typeof forEachCycle, 'cycleSearch exports forEachCycle').toBe('function');
    const visit = forEachCycle as (
      graph: ReadonlyMap<string, readonly string[]>,
      visitor: (path: readonly string[], start: number) => void,
    ) => void;
    const members = multiCompleteMembers(8);
    const edges = search.cycleEdges(members);
    const seen: string[][] = [];
    visit(edges, (path, start) => {
      seen.push(path.slice(start).concat(path[start] ?? ''));
    });
    expect(seen).toEqual(exhaustiveCyclePaths(edges));
  });
});
