export interface CycleMember {
  id: string;
  tokenId: string;
  dependencies: readonly string[];
}

/**
 * Registration graph. A dependency that is not a key is left out.
 * A set per member drops a repeated target and keeps the first-seen order.
 */
export function cycleEdges(
  members: readonly CycleMember[],
  skipTokens?: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const byToken = new Map<string, string[]>();
  for (const member of members) {
    const list = byToken.get(member.tokenId);
    if (list) list.push(member.id);
    else byToken.set(member.tokenId, [member.id]);
  }
  const graph = new Map<string, string[]>();
  for (const member of members) graph.set(member.id, []);
  for (const member of members) {
    const edges = graph.get(member.id);
    if (!edges) continue;
    const seen = new Set<string>();
    for (const dep of member.dependencies) {
      if (skipTokens?.has(dep)) continue;
      const targets = byToken.get(dep);
      if (!targets) continue;
      for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        edges.push(target);
      }
    }
  }
  return graph;
}

interface Frame {
  id: string;
  next: number;
  dependencies: readonly string[];
}

/**
 * Iterative depth-first search. Calls `visit` once per back edge with the live
 * stack and the index where the cycle starts. The cycle is `path.slice(start)`
 * followed by `path[start]`. The array is reused: copy it to keep it.
 */
export function forEachCycle(
  graph: ReadonlyMap<string, readonly string[]>,
  visit: (path: readonly string[], start: number) => void,
): void {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const position = new Map<string, number>();
  const frames: Frame[] = [];
  const enter = (id: string): void => {
    state.set(id, 1);
    position.set(id, path.length);
    path.push(id);
    frames.push({ id, next: 0, dependencies: graph.get(id) ?? [] });
  };
  for (const root of graph.keys()) {
    if (state.has(root)) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      if (frame.next === frame.dependencies.length) {
        frames.pop();
        path.pop();
        position.delete(frame.id);
        state.set(frame.id, 2);
        continue;
      }
      const dependency = frame.dependencies[frame.next];
      frame.next += 1;
      if (dependency === undefined) continue;
      if (!graph.has(dependency)) continue;
      if (!state.has(dependency)) enter(dependency);
      else if (state.get(dependency) === 1) {
        const start = position.get(dependency);
        if (start === undefined) continue;
        visit(path, start);
      }
    }
  }
}

/** What one token-set group keeps: its first path and, for one multi token, the contributions seen. */
export interface CycleGroup {
  /** The first path of the group, copied once. It repeats its start at the end. */
  readonly first: readonly string[];
  /** Contribution ids of a group made of one multi token, in first-seen order. Empty otherwise. */
  readonly contributions: readonly string[];
}

export interface CycleGrouping {
  /** One report per token set. Several contributions of one multi token each get their own `[id, id]`. */
  readonly reports: { ids: string[] }[];
  /** The only data kept from the search: one path per group, plus the contributions of multi groups. */
  readonly groups: readonly CycleGroup[];
}

interface OpenGroup {
  tokens: string[];
  first: string[];
  contributions: string[] | undefined;
  seen: Set<string> | undefined;
}

/**
 * One report per token set, from a single streaming search.
 * A group keeps its first path only. A group made of one multi token also keeps the
 * ids of the contributions that appear in its cycles, so the count stays one error per contribution.
 */
export function cycleGroups(
  graph: ReadonlyMap<string, readonly string[]>,
  tokenOf: (id: string) => string,
  multiTokens: ReadonlySet<string>,
): CycleGrouping {
  const groups = new Map<string, OpenGroup>();
  forEachCycle(graph, (path, start) => {
    const tokens = new Set<string>();
    for (let index = start; index < path.length; index += 1) tokens.add(tokenOf(path[index] as string));
    const sorted = [...tokens].sort();
    const key = sorted.join('\0');
    let group = groups.get(key);
    if (!group) {
      const single = sorted.length === 1 && multiTokens.has(sorted[0] as string);
      group = {
        tokens: sorted,
        first: path.slice(start).concat(path[start] as string),
        contributions: single ? [] : undefined,
        seen: single ? new Set<string>() : undefined,
      };
      groups.set(key, group);
    }
    if (group.seen && group.contributions) {
      for (let index = start; index < path.length; index += 1) {
        const id = path[index] as string;
        if (group.seen.has(id)) continue;
        group.seen.add(id);
        group.contributions.push(id);
      }
    }
  });
  const reports: { ids: string[] }[] = [];
  const kept: CycleGroup[] = [];
  for (const group of groups.values()) {
    kept.push({ first: group.first, contributions: group.contributions ?? [] });
    if (group.contributions && group.contributions.length > 1) {
      for (const id of group.contributions) reports.push({ ids: [id, id] });
      continue;
    }
    reports.push({ ids: [...group.first] });
  }
  return { reports, groups: kept };
}
