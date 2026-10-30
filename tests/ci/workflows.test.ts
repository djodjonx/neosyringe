import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  continueOnError: boolean;
  with: Record<string, string | number>;
}

interface Job {
  needs: string[];
  if?: string;
  continueOnError: boolean;
  permissions: Record<string, string>;
  steps: Step[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function asStep(value: unknown): Step {
  if (!isRecord(value)) throw new Error('workflow step is not an object');
  const withValues: Record<string, string | number> = {};
  if (isRecord(value.with)) {
    for (const [key, item] of Object.entries(value.with)) {
      if (typeof item === 'string' || typeof item === 'number') withValues[key] = item;
    }
  }
  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    uses: typeof value.uses === 'string' ? value.uses : undefined,
    run: typeof value.run === 'string' ? value.run : undefined,
    continueOnError: value['continue-on-error'] === true,
    with: withValues,
  };
}

function asJob(value: unknown): Job {
  if (!isRecord(value)) throw new Error('workflow job is not an object');
  return {
    needs: stringList(value.needs),
    if: typeof value.if === 'string' ? value.if : undefined,
    continueOnError: value['continue-on-error'] === true,
    permissions: stringMap(value.permissions),
    steps: Array.isArray(value.steps) ? value.steps.map(asStep) : [],
  };
}

function loadJobs(file: string): Record<string, Job> {
  const parsed: unknown = parse(readFileSync(path.join(root, file), 'utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.jobs)) throw new Error(`no jobs in ${file}`);
  const jobs: Record<string, Job> = {};
  for (const [name, job] of Object.entries(parsed.jobs)) jobs[name] = asJob(job);
  return jobs;
}

function runs(job: Job): string[] {
  return job.steps.map((step) => step.run).filter((run): run is string => run !== undefined);
}

function reaches(jobs: Record<string, Job>, start: string, target: string): boolean {
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    const job = jobs[current];
    if (job) pending.push(...job.needs);
  }
  return false;
}

describe('CI workflows', () => {
  it('T13-A01 e2e after build', () => {
    const jobs = loadJobs('.github/workflows/ci.yml');
    const e2e = jobs.e2e;
    expect(e2e).toBeDefined();
    const commands = runs(e2e!);
    const buildAt = commands.indexOf('pnpm build');
    const e2eAt = commands.indexOf('pnpm test:e2e');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(e2eAt).toBeGreaterThan(buildAt);
    expect(e2e!.continueOnError).toBe(false);
    const e2eStep = e2e!.steps.find((step) => step.run === 'pnpm test:e2e');
    expect(e2eStep?.continueOnError).toBe(false);
    const setup = e2e!.steps.find((step) => step.uses === './.github/actions/setup-node-pnpm');
    expect(String(setup?.with['node-version'])).toBe('22');
  });

  it('T13-A05 publish needs verify', () => {
    const jobs = loadJobs('.github/workflows/release.yml');
    const publishing = ['publish', 'publish-vscode', 'update-examples'];
    for (const name of publishing) {
      expect(reaches(jobs, name, 'verify'), name).toBe(true);
      const condition = jobs[name]?.if ?? '';
      expect(condition.includes('always()'), name).toBe(false);
      expect(condition.includes('failure()'), name).toBe(false);
      expect(condition.includes('cancelled()'), name).toBe(false);
    }
    const releasePlease = jobs['release-please'];
    expect(releasePlease?.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(releasePlease?.if).toContain("github.event.workflow_run.event == 'push'");
    const publish = jobs.publish;
    expect(runs(publish!).join('\n')).toContain('--provenance');
    expect(publish?.permissions['id-token']).toBe('write');
    const verifyCommands = runs(jobs.verify!);
    expect(verifyCommands).toContain('pnpm build');
    expect(verifyCommands).toContain('pnpm lint');
    expect(verifyCommands).toContain('pnpm typecheck');
    expect(verifyCommands).toContain('pnpm test:coverage');
    expect(verifyCommands).toContain('pnpm test:ci');
    expect(verifyCommands).toContain('pnpm test:e2e');
    expect(verifyCommands).toContain('node scripts/ci/consumer-types.mjs tests/consumer-types/positive');
    expect(verifyCommands).toContain(
      'node scripts/ci/consumer-types.mjs tests/consumer-types/negative --expect-file expected-diagnostic.txt',
    );
    expect(verifyCommands).toContain('node scripts/ci/check-dist.mjs');
  });

  it('T13-A06 required aggregator', () => {
    const jobs = loadJobs('.github/workflows/ci.yml');
    const required = jobs.required;
    expect(required?.if).toBe('always()');
    expect(required?.needs).toEqual(['test', 'security', 'e2e', 'consumer-types', 'distribution']);
    expect(runs(required!)).toContain('node scripts/ci/required-results.mjs');
    expect(runs(jobs.test!)).toContain('pnpm test:ci');

    const skipped = spawnSync(process.execPath, ['scripts/ci/required-results.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, JOB_RESULTS: JSON.stringify({ security: { result: 'skipped' } }) },
    });
    expect(skipped.status).toBe(1);

    const success = spawnSync(process.execPath, ['scripts/ci/required-results.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        JOB_RESULTS: JSON.stringify({
          test: { result: 'success' },
          security: { result: 'success' },
        }),
      },
    });
    expect(success.status).toBe(0);
  });

  it('T13-A06 jobs that run repo scripts check out first', () => {
    const files = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];
    for (const file of files) {
      const jobs = loadJobs(file);
      for (const [name, job] of Object.entries(jobs)) {
        const checkoutAt = job.steps.findIndex((step) => step.uses?.startsWith('actions/checkout') === true);
        for (const [index, step] of job.steps.entries()) {
          const command = step.run ?? '';
          if (!command.startsWith('node scripts/') && !command.startsWith('pnpm ')) continue;
          expect(checkoutAt, `${file} ${name}`).toBeGreaterThanOrEqual(0);
          expect(checkoutAt, `${file} ${name}`).toBeLessThan(index);
        }
      }
    }
  });
});
