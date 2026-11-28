import { createHash } from 'node:crypto';
import type { SourceOrigin, SourceRewrite } from '../analyzer/types';

/**
 * Helpers an emitter can ask for by id. Only the two generic resolvers are named here:
 * every other private helper of the generated class is still decided by a flag of the graph.
 */
export type HelperId = 'resolveSingle' | 'resolveAll' | 'factoryPolicy' | 'factoryLease' | 'factoryContext';

/** Text the generator wrote, or a copy of a range of a source file taken from one snapshot. */
export type Part =
  | { readonly kind: 'generated'; readonly text: string }
  | {
      readonly kind: 'source'; readonly snapshot: string; readonly file: string;
      readonly start: number; readonly length: number;
    };

/** What an emitter returns: its text and the helpers that text calls. */
export interface Fragment {
  readonly parts: readonly Part[];
  readonly needs: readonly HelperId[];
}

export interface Helper extends Fragment { readonly id: HelperId }

/** Anything a {@link fragment} template accepts between two text chunks. */
export type Piece = string | Part | Fragment;

export function generatedText(text: string): Part {
  return { kind: 'generated', text };
}

function isFragment(piece: Piece): piece is Fragment {
  return typeof piece === 'object' && 'parts' in piece;
}

function isPart(piece: Piece): piece is Part {
  return typeof piece === 'object' && 'kind' in piece;
}

/** Accumulates parts and needs. Neighbouring generated text is merged into one part. */
class FragmentBuilder {
  private readonly parts: Part[] = [];
  private readonly needs = new Set<HelperId>();

  add(piece: Piece): void {
    if (typeof piece === 'string') {
      this.addPart(generatedText(piece));
    } else if (isFragment(piece)) {
      for (const part of piece.parts) this.addPart(part);
      for (const need of piece.needs) this.needs.add(need);
    } else if (isPart(piece)) {
      this.addPart(piece);
    }
  }

  private addPart(part: Part): void {
    if (part.kind === 'generated') {
      if (part.text.length === 0) return;
      const last = this.parts[this.parts.length - 1];
      if (last?.kind === 'generated') {
        this.parts[this.parts.length - 1] = generatedText(last.text + part.text);
        return;
      }
    }
    this.parts.push(part);
  }

  build(): Fragment {
    return { parts: this.parts, needs: [...this.needs] };
  }
}

/**
 * Builds a fragment from a template. A string between the chunks is generated text, a part is kept
 * as it is, a fragment brings its parts and its needs. Needs keep the order of first appearance.
 */
export function fragment(strings: TemplateStringsArray, ...values: readonly Piece[]): Fragment {
  const builder = new FragmentBuilder();
  strings.forEach((chunk, index) => {
    builder.add(chunk);
    if (index < values.length) builder.add(values[index]);
  });
  return builder.build();
}

/** The same fragment, with more needs. A need already there is not repeated. */
export function withNeeds(base: Fragment, needs: readonly HelperId[]): Fragment {
  return { parts: base.parts, needs: [...new Set([...base.needs, ...needs])] };
}

/** Joins pieces with a separator of generated text. */
export function concat(pieces: readonly Piece[], separator = ''): Fragment {
  const builder = new FragmentBuilder();
  pieces.forEach((piece, index) => {
    if (index > 0) builder.add(separator);
    builder.add(piece);
  });
  return builder.build();
}

/**
 * The helpers `roots` need, directly or through other helpers, in catalog order.
 * A helper that nobody needs is absent. A missing id and a duplicate id are errors.
 */
export function selectHelpers(roots: readonly Fragment[], catalog: readonly Helper[]): Helper[] {
  const byId = new Map(catalog.map((helper) => [helper.id, helper]));
  if (byId.size !== catalog.length) throw new Error('duplicate helper');
  const needed = new Set<HelperId>();
  const pending = roots.flatMap((root) => [...root.needs]);
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor];
    if (needed.has(id)) continue;
    const helper = byId.get(id);
    if (!helper) throw new Error(`missing helper: ${id}`);
    needed.add(id);
    pending.push(...helper.needs);
  }
  return catalog.filter((helper) => needed.has(helper.id));
}

/** The parts of the helpers `roots` need, then the parts of `roots`. */
export function linkHelpers(roots: readonly Fragment[], catalog: readonly Helper[]): Part[] {
  // Catalog order is deterministic; these are effect-free declarations.
  return [
    ...selectHelpers(roots, catalog).flatMap((helper) => helper.parts),
    ...roots.flatMap((root) => root.parts),
  ];
}

/**
 * Names for generated top-level bindings. A key gets one name for the life of the pool.
 *
 * Deviation from the reference signature: `forKey(key, preferred?)`. A `preferred` name is the
 * name the generator has always written (`Import_0`, `NeoContainer_<hash>`), so existing output
 * does not change. It is kept while it is free and takes a `_<n>` suffix only on a collision.
 * Without `preferred` the name is `__neo_<n>` (base 36), as in the reference.
 * The pool holds all its state: two pools never influence each other.
 */
export class NamePool {
  private readonly used: Set<string>;
  private readonly assigned = new Map<string, string>();
  private next = 0;

  constructor(reserved: Iterable<string>) {
    this.used = new Set(reserved);
  }

  forKey(semanticKey: string, preferred?: string): string {
    const previous = this.assigned.get(semanticKey);
    if (previous !== undefined) return previous;
    let name: string;
    if (preferred === undefined) {
      do { name = `__neo_${(this.next++).toString(36)}`; } while (this.used.has(name));
    } else {
      name = preferred;
      for (let suffix = 1; this.used.has(name); suffix++) name = `${preferred}_${suffix}`;
    }
    this.used.add(name);
    this.assigned.set(semanticKey, name);
    return name;
  }
}

/** The files a render may copy from, all read at one moment. */
export interface Snapshot {
  readonly id: string;
  readonly files: ReadonlyMap<string, string>;
}

/**
 * A snapshot named by what it holds: the id is a hash of the file names and texts, so the parts
 * cut from one analysis are refused by the snapshot of another (`render`), and no path or source
 * text shows in the id. The same files, in any order, give the same id.
 */
export function snapshotOfFiles(files: ReadonlyMap<string, string>): Snapshot {
  const entries = [...files].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const id = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 24);
  return { id, files };
}

/** One copied range: where it starts in the generated code and where it comes from. UTF-16 offsets. */
export interface CopyMapping {
  readonly generatedStart: number;
  readonly sourceFile: string;
  readonly sourceStart: number;
  readonly length: number;
}

export function render(parts: readonly Part[], snapshot: Snapshot): {
  code: string; copies: readonly CopyMapping[];
} {
  const chunks: string[] = [];
  const copies: CopyMapping[] = [];
  let generatedStart = 0;
  for (const part of parts) {
    let text: string;
    if (part.kind === 'generated') {
      text = part.text;
    } else {
      if (part.snapshot !== snapshot.id) throw new Error('stale source snapshot');
      const source = snapshot.files.get(part.file);
      if (source === undefined) throw new Error('missing source file');
      if (!Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.length)
        || part.start < 0 || part.length < 0 || part.start > source.length
        || part.length > source.length - part.start) throw new Error('invalid source range');
      text = source.slice(part.start, part.start + part.length);
      copies.push({ generatedStart, sourceFile: part.file, sourceStart: part.start, length: part.length });
    }
    chunks.push(text);
    generatedStart += text.length;
  }
  return { code: chunks.join(''), copies };
}

/**
 * Turns the text of a user expression into parts. A range that still reads the same text in the
 * snapshot is a `source` part (a copy that can be mapped). `rewrites` are changes the plugin makes
 * inside that range: each one becomes generated text and the text between them stays `source`.
 * Text the snapshot does not hold, or a graph built without an origin, is generated text: no
 * mapping is claimed for it.
 */
export type UserCopy = (
  text: string,
  origin: SourceOrigin | undefined,
  rewrites?: readonly SourceRewrite[],
) => readonly Part[];

/**
 * The rewrites that sit inside `origin`, in position order. One that starts inside the previous
 * one is dropped: two edits of one range cannot both apply.
 */
function rewritesInside(origin: SourceOrigin, rewrites: readonly SourceRewrite[]): SourceRewrite[] {
  const end = origin.start + origin.length;
  const inside = rewrites
    .filter((rewrite) => rewrite.start >= origin.start && rewrite.end >= rewrite.start && rewrite.end <= end)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const kept: SourceRewrite[] = [];
  let cursor = origin.start;
  for (const rewrite of inside) {
    if (rewrite.start < cursor) continue;
    kept.push(rewrite);
    cursor = rewrite.end;
  }
  return kept;
}

/** `text` with its rewrites applied, as plain text. */
function rewrittenText(text: string, origin: SourceOrigin | undefined, rewrites: readonly SourceRewrite[] | undefined): string {
  if (!origin || !rewrites || rewrites.length === 0) return text;
  let result = '';
  let cursor = origin.start;
  for (const rewrite of rewritesInside(origin, rewrites)) {
    result += text.slice(cursor - origin.start, rewrite.start - origin.start) + rewrite.text;
    cursor = rewrite.end;
  }
  return result + text.slice(cursor - origin.start);
}

/** The copy used when no snapshot is available: every expression is generated text. */
export const generatedCopy: UserCopy = (text, origin, rewrites) => [generatedText(rewrittenText(text, origin, rewrites))];

export function copyFromSnapshot(snapshot: Snapshot): UserCopy {
  return (text, origin, rewrites) => {
    if (!origin) return [generatedText(text)];
    const source = snapshot.files.get(origin.file);
    if (source === undefined || source.slice(origin.start, origin.start + origin.length) !== text) {
      return [generatedText(rewrittenText(text, origin, rewrites))];
    }
    const parts: Part[] = [];
    const copy = (start: number, end: number): void => {
      if (end > start) parts.push({ kind: 'source', snapshot: snapshot.id, file: origin.file, start, length: end - start });
    };
    let cursor = origin.start;
    for (const rewrite of rewritesInside(origin, rewrites ?? [])) {
      copy(cursor, rewrite.start);
      if (rewrite.text.length > 0) parts.push(generatedText(rewrite.text));
      cursor = rewrite.end;
    }
    copy(cursor, origin.start + origin.length);
    return parts;
  };
}
