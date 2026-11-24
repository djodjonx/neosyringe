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

/** Iterative depth-first search. Each path repeats its start at the end. */
export function cyclePaths(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const position = new Map<string, number>();
  const cycles: string[][] = [];
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
        cycles.push(path.slice(start).concat(dependency));
      }
    }
  }
  return cycles;
}

/**
 * One report per token set. Several contributions of one multi token each
 * get their own `[id, id]` path so the count stays one error per contribution.
 */
export function groupCycles(
  paths: readonly (readonly string[])[],
  tokenOf: (id: string) => string,
  multiTokens: ReadonlySet<string>,
): { ids: string[] }[] {
  const groups = new Map<string, string[][]>();
  for (const path of paths) {
    const body = path.slice(0, -1);
    if (body.length === 0) continue;
    const tokens = [...new Set(body.map((id) => tokenOf(id)))].sort();
    const key = tokens.join('\0');
    const list = groups.get(key);
    const copy = [...path];
    if (list) list.push(copy);
    else groups.set(key, [copy]);
  }
  const reports: { ids: string[] }[] = [];
  for (const [key, list] of groups) {
    const first = list[0];
    if (!first) continue;
    const tokens = key.length === 0 ? [] : key.split('\0');
    const token = tokens[0];
    if (tokens.length === 1 && token !== undefined && multiTokens.has(token)) {
      const seen = new Set<string>();
      const contributions: string[] = [];
      for (const cycle of list) {
        for (const id of cycle.slice(0, -1)) {
          if (seen.has(id)) continue;
          seen.add(id);
          contributions.push(id);
        }
      }
      if (contributions.length > 1) {
        for (const id of contributions) reports.push({ ids: [id, id] });
        continue;
      }
    }
    reports.push({ ids: first });
  }
  return reports;
}
