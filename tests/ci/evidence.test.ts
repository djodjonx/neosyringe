import { describe, expect, it } from 'vitest';
import { assertCandidateReady, assertVerified, type CheckEvidence, type TaskEvidence } from '../../scripts/ci/lib/evidence.mjs';

const SHA = 'ba192b457f0efa13149cc7f64a647c7d9b5c86b3';
const ARTIFACT = 't00-archives';
const NAMED = [
  'types',
  'no-unsafe-types',
  'unit',
  'e2e',
  'dist-esm',
  'dist-cjs',
  'benchmarks',
  'integration-composition',
  'scopes-soak',
  'watch-soak',
  'workspace-consumer',
] as const;
const REQUIRED = [
  ...Array.from({ length: 24 }, (_, id) => `topic-${String(id).padStart(2, '0')}`),
  'types',
  'no-unsafe-types',
  'unit',
  'e2e',
  'dist-esm',
  'dist-cjs',
  'benchmarks',
  'integration-composition',
  'scopes-soak',
  'watch-soak',
  'workspace-consumer',
];

function messageOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

function check(id: string, patch: Partial<CheckEvidence> = {}): CheckEvidence {
  return {
    id,
    status: 'passed',
    sourceSha: SHA,
    artifactSet: ARTIFACT,
    ...patch,
  };
}

function ready(checks: readonly CheckEvidence[] = REQUIRED.map((id) => check(id))): void {
  assertCandidateReady(SHA, ARTIFACT, checks);
}

function verified(patch: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    task: 'topic-00',
    baseSha: SHA,
    status: 'verified',
    commands: [{ command: 'pnpm test', exitCode: 0, log: 'ok' }],
    measurements: [],
    contractChanges: [],
    limitations: [],
    ...patch,
  };
}

describe('T00 evidence', () => {
  it('evidence rejects a sha that is not 40 lowercase hex', () => {
    expect(messageOf(() => assertCandidateReady(SHA.toUpperCase(), ARTIFACT, REQUIRED.map((id) => check(id))))).toBe(
      'invalid candidate identity',
    );
  });

  it('evidence rejects an empty artifact set', () => {
    expect(messageOf(() => assertCandidateReady(SHA, '', REQUIRED.map((id) => check(id))))).toBe(
      'invalid candidate identity',
    );
  });

  it('evidence rejects a duplicate id', () => {
    const checks = REQUIRED.map((id) => check(id));
    checks.push(check('topic-00'));
    expect(messageOf(() => ready(checks))).toBe('duplicate evidence');
  });

  it('evidence rejects a missing topic-23', () => {
    const checks = REQUIRED.filter((id) => id !== 'topic-23').map((id) => check(id));
    expect(messageOf(() => ready(checks))).toBe('missing, stale or failing evidence: topic-23');
  });

  it.each(NAMED)('evidence rejects a missing %s', (id) => {
    const checks = REQUIRED.filter((item) => item !== id).map((item) => check(item));
    expect(messageOf(() => ready(checks))).toBe(`missing, stale or failing evidence: ${id}`);
  });

  it('evidence rejects a check that did not pass', () => {
    const checks = REQUIRED.map((id) => check(id, id === 'topic-00' ? { status: 'failed' } : {}));
    expect(messageOf(() => ready(checks))).toBe('missing, stale or failing evidence: topic-00');
  });

  it('evidence rejects a check from another sha', () => {
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const checks = REQUIRED.map((id) => check(id, id === 'topic-00' ? { sourceSha: other } : {}));
    expect(messageOf(() => ready(checks))).toBe('missing, stale or failing evidence: topic-00');
  });

  it('evidence rejects a check from another artifact set', () => {
    const checks = REQUIRED.map((id) => check(id, id === 'topic-00' ? { artifactSet: 'other-archives' } : {}));
    expect(messageOf(() => ready(checks))).toBe('missing, stale or failing evidence: topic-00');
  });

  it('evidence accepts a complete passing candidate', () => {
    expect(messageOf(() => ready())).toBe('');
    expect(assertCandidateReady(SHA, ARTIFACT, REQUIRED.map((id) => check(id)))).toBeUndefined();
  });

  it('evidence rejects a task that is not verified', () => {
    expect(messageOf(() => assertVerified(verified({ status: 'implemented' })))).toBe('task is not verified');
  });

  it('evidence rejects a verified task with no base sha', () => {
    expect(messageOf(() => assertVerified(verified({ baseSha: '' })))).toBe(
      'missing provenance or verification commands',
    );
  });

  it('evidence rejects a verified task with no commands', () => {
    expect(messageOf(() => assertVerified(verified({ commands: [] })))).toBe(
      'missing provenance or verification commands',
    );
  });

  it('evidence rejects a failing verification command', () => {
    expect(
      messageOf(() => assertVerified(verified({ commands: [{ command: 'pnpm test', exitCode: 1, log: 'fail' }] }))),
    ).toBe('unresolved failing verification');
  });

  it('evidence accepts a verified task', () => {
    const evidence = verified();
    expect(messageOf(() => assertVerified(evidence))).toBe('');
    expect(assertVerified(evidence)).toBeUndefined();
  });
});
