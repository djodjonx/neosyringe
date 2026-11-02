import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repoRoot, 'packages/cli/dist/index.mjs');

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const GOOD = `${STUB}
  class E2eRepo {}
  class E2eService { constructor(repo: E2eRepo) {} }
  export const good = defineBuilderConfig({
    name: 'E2eGood',
    optimization: { mode: 'closed', roots: [E2eService] },
    injections: [{ token: E2eService }, { token: E2eRepo }],
  });
`;

// `E2eAbsent` is provided by the other container only.
const BAD = `${STUB}
  interface E2eAbsent { n: number }
  class E2eNeedy { constructor(dep: E2eAbsent) {} }
  export const needy = defineBuilderConfig({ name: 'E2eNeedy', injections: [{ token: E2eNeedy }] });
  export const supplier = defineBuilderConfig({
    name: 'E2eSupplier',
    injections: [{ token: useInterface<E2eAbsent>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
  });
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let scratch = '';
let goodDir = '';
let badDir = '';

function project(name: string, source: string): string {
  const dir = path.join(scratch, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES5'], types: [], skipLibCheck: true },
    include: ['src/**/*.ts'],
  }));
  writeFileSync(path.join(dir, 'src/app.ts'), source);
  return dir;
}

function run(cwd: string, args: string[]): Run {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('T19 CLI end to end', () => {
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 't19-e2e-'));
    goodDir = project('good', GOOD);
    badDir = project('bad', BAD);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('T19 --retention-report prints only the report on stdout', () => {
    const result = run(goodDir, ['--retention-report']);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.schemaVersion).toBe(1);
    expect(report.containers.map((item: { containerName: string }) => item.containerName)).toEqual(['E2eGood']);
    expect(result.stderr).toContain('Analyzing project');
    expect(result.stdout).not.toContain('Analyzing project');
  });

  it('T19 --retention-report keeps stdout valid when validation fails', () => {
    const result = run(badDir, ['--retention-report']);

    expect(JSON.parse(result.stdout).schemaVersion).toBe(1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Validation failed');
  });

  it('T19 a dash-led value is a flag: --retention-report -p', () => {
    const result = run(goodDir, ['--retention-report', '-p', 'tsconfig.json']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).schemaVersion).toBe(1);
  });

  it('T19 --json with --retention-report <path> writes the file and still validates', () => {
    const target = path.join(badDir, 'out', 'retention.json');
    const result = run(badDir, ['--json', '--retention-report', target]);
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(report.schemaVersion).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatchObject({ code: 'NEO_MISSING_PROVIDER', severity: 'error', containerName: 'E2eNeedy', containerFile: 'src/app.ts' });
    expect(JSON.parse(readFileSync(target, 'utf8')).schemaVersion).toBe(1);

    const clean = run(goodDir, ['--json', '--retention-report', path.join(goodDir, 'r.json')]);
    expect(clean.status).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ schemaVersion: 1, ok: true });
  });

  it('T19 --explain is exclusive and dangling flags are usage errors', () => {
    const withGraph = run(goodDir, ['--explain', 'E2eRepo', '--graph', 'g.html']);
    const asJson = run(goodDir, ['--json', '--explain', 'E2eRepo', '--mermaid']);
    const noToken = run(goodDir, ['--explain']);
    const alone = run(goodDir, ['--container', 'E2eGood']);
    const twoDocuments = run(goodDir, ['--json', '--retention-report']);

    for (const result of [withGraph, noToken, alone]) {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    }
    expect(asJson.status).toBe(2);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ schemaVersion: 1, ok: false });
    expect(JSON.parse(asJson.stdout).fatal).toContain('--explain');
    expect(twoDocuments.status).toBe(2);
    expect(JSON.parse(twoDocuments.stdout).fatal).toContain('--retention-report');
  });

  it('T19 --explain exits 0, 1 for an absent token, 1 for an unknown container', () => {
    const found = run(goodDir, ['--explain', 'E2eRepo', '--json']);
    const absent = run(goodDir, ['--explain', 'NoSuchToken', '--json']);
    const unknown = run(goodDir, ['--explain', 'E2eRepo', '--container', 'NoSuchContainer', '--json']);

    expect(found.status).toBe(0);
    expect(JSON.parse(found.stdout).results[0]).toMatchObject({ found: true, cause: 'dependency-of', path: ['E2eService', 'E2eRepo'] });
    expect(absent.status).toBe(1);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout).results[0]).toMatchObject({ found: false, containerFound: false, container: 'NoSuchContainer' });
  });

  it('T19 --graph still validates and writes the page', () => {
    const target = path.join(badDir, 'graph.html');
    const result = run(badDir, ['--json', '--graph', target]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors[0].code).toBe('NEO_MISSING_PROVIDER');
    expect(readFileSync(target, 'utf8')).toContain('E2eNeedy');
  });
});
