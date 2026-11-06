import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// T21-A05 and T21-A06: the delivery dossier is checked against the repository.
// It reads docs/release/qualification.md and the test files it names. No clock, no network.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dossierPath = path.join(root, 'docs/release/qualification.md');
const BASE_CI_RUN = '42218196764';
const STATUS = /^(local|not executed|remote CI \(run id (\d+)\))$/;
const REQUIRED_COMMANDS = [
  'pnpm build',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm test:e2e',
  'pnpm test:coverage',
  'pnpm docs:build',
  'pnpm test:ci',
  'node scripts/ci/consumer-dist.mjs',
];

/**
 * What is wrong with the status of a row of "Commands run". That table lists runs of the candidate:
 * `remote CI (run id N)` is allowed for a candidate run, never for the base run, which only the text
 * may cite when it labels it as the base.
 */
function statusProblem(status: string): string | undefined {
  const match = STATUS.exec(status);
  if (match === null) return `status "${status}" is not local, not executed or remote CI (run id N)`;
  if (match[2] === BASE_CI_RUN) return `the base run ${BASE_CI_RUN} is not a result of the candidate`;
  return undefined;
}

function dossier(): string {
  return readFileSync(dossierPath, 'utf8');
}

/** The text under `## title`, up to the next level-2 heading. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `missing section "${title}"`).toBeGreaterThanOrEqual(0);
  const body = text.slice(start + 1);
  const next = body.indexOf('\n## ', 4);
  return next < 0 ? body : body.slice(0, next);
}

/** Table rows without the header and the separator, each one as trimmed cells. */
function tableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.slice(1, line.lastIndexOf('|')).split('|').map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)))
    .slice(1);
}

interface Ref {
  file: string;
  title: string;
}

/** Every `file::test name` code span of a text. */
function refsIn(text: string): Ref[] {
  return [...text.matchAll(/`([^`\s][^`]*?\.ts)::([^`]+)`/g)].map((match) => ({
    file: match[1] ?? '',
    title: match[2] ?? '',
  }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What is wrong with a reference, or undefined when the file holds a test with exactly that title. */
function problemWith(ref: Ref): string | undefined {
  if (ref.file.includes('..') || path.isAbsolute(ref.file)) return `${ref.file}: path leaves the repository`;
  const full = path.join(root, ref.file);
  if (!existsSync(full)) return `${ref.file}: file does not exist`;
  const source = readFileSync(full, 'utf8');
  const named = new RegExp(`\\b(?:it|test)\\(\\s*(['"\`])${escapeRegExp(ref.title)}\\1`);
  return named.test(source) ? undefined : `${ref.file}: no test is titled "${ref.title}"`;
}

function problemsOf(refs: Ref[]): string[] {
  return refs.map(problemWith).filter((problem): problem is string => problem !== undefined);
}

function nsRows(text: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const cells of tableRows(section(text, 'NS001-NS017'))) rows.set(cells[0] ?? '', cells);
  return rows;
}

describe('T21 dossier', () => {
  it('T21-A05 every NS row names an existing file::test name', () => {
    const problems: string[] = [];
    for (const [id, cells] of nsRows(dossier())) {
      const refs = refsIn(cells.join(' '));
      if (refs.length === 0) problems.push(`${id}: no file::test name`);
      for (const problem of problemsOf(refs)) problems.push(`${id}: ${problem}`);
    }
    expect(problems).toEqual([]);
  });

  it('T21-A05 every other file::test name of the dossier exists too', () => {
    const text = dossier();
    const ns = section(text, 'NS001-NS017');
    const outside = refsIn(text.replace(ns, ''));
    expect(outside.length).toBeGreaterThan(0);
    expect(problemsOf(outside)).toEqual([]);
  });

  it('T21-A05 a row that names a missing test or file is reported', () => {
    const table = [
      '| NS | Finding | Tests |',
      '|----|---------|-------|',
      '| NS999 | Made up | `tests/ci/t21-dossier.test.ts::a title nobody wrote` |',
      '| NS998 | Made up | `tests/ci/no-such-file.test.ts::T21-A06 every command row has a status` |',
      '| NS997 | Real | `tests/ci/t21-dossier.test.ts::T21-A05 NS001..NS017 all have a row` |',
    ].join('\n');
    const rows = tableRows(table);
    expect(rows.map((cells) => problemsOf(refsIn(cells.join(' '))))).toEqual([
      ['tests/ci/t21-dossier.test.ts: no test is titled "a title nobody wrote"'],
      ['tests/ci/no-such-file.test.ts: file does not exist'],
      [],
    ]);
  });

  it('T21-A05 NS001..NS017 all have a row', () => {
    const rows = nsRows(dossier());
    const expected = Array.from({ length: 17 }, (_, index) => `NS${String(index + 1).padStart(3, '0')}`);
    expect([...rows.keys()]).toEqual(expected);
  });

  it('T21-A05 versions table equals packages/*/package.json', () => {
    const rows = tableRows(section(dossier(), 'Versions')).filter((cells) => cells.length === 3);
    const listed = rows
      .map((cells) => ({
        name: (cells[0] ?? '').replace(/`/g, ''),
        directory: (cells[1] ?? '').replace(/`/g, ''),
        version: (cells[2] ?? '').replace(/`/g, ''),
      }))
      .sort((a, b) => a.directory.localeCompare(b.directory));
    const onDisk = readdirSync(path.join(root, 'packages'))
      .filter((name) => existsSync(path.join(root, 'packages', name, 'package.json')))
      .map((name) => {
        const manifest = JSON.parse(readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')) as {
          name: string;
          version: string;
        };
        return { name: manifest.name, directory: `packages/${name}`, version: manifest.version };
      })
      .sort((a, b) => a.directory.localeCompare(b.directory));
    expect(listed).toEqual(onDisk);
  });

  it('T21-A06 every command row has a status', () => {
    const rows = tableRows(section(dossier(), 'Commands run'));
    expect(rows.length).toBeGreaterThanOrEqual(REQUIRED_COMMANDS.length);
    const problems: string[] = [];
    for (const cells of rows) {
      const [, command = '', status = '', exit = '', result = ''] = cells;
      const statusError = statusProblem(status);
      if (statusError !== undefined) {
        problems.push(`"${command}": ${statusError}`);
        continue;
      }
      if (status === 'local' && !/^\d+$/.test(exit)) problems.push(`"${command}": local row without an exit code`);
      if (result === '') problems.push(`"${command}": no result`);
    }
    expect(problems).toEqual([]);
    const commands = rows.map((cells) => (cells[1] ?? '').replace(/`/g, ''));
    for (const required of REQUIRED_COMMANDS) {
      expect(commands, `no row for ${required}`).toContain(required);
    }
  });

  it('T21-A06 a command row cannot cite the base run, a candidate run id is allowed', () => {
    expect(statusProblem('local')).toBeUndefined();
    expect(statusProblem('not executed')).toBeUndefined();
    expect(statusProblem('remote CI (run id 99999999999)')).toBeUndefined();
    expect(statusProblem(`remote CI (run id ${BASE_CI_RUN})`)).toBe(
      `the base run ${BASE_CI_RUN} is not a result of the candidate`,
    );
    expect(statusProblem('green')).toBe('status "green" is not local, not executed or remote CI (run id N)');
  });

  it('T21-A06 the base CI run is never presented as the candidate', () => {
    const text = dossier();
    const lines = text.split('\n').filter((line) => line.includes(BASE_CI_RUN));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line, line).toMatch(/base/i);
    expect(text).toContain('`bf23efa`');
    expect(text).toMatch(/pull request body/);
    expect(text).not.toContain('PENDING');
  });
});
