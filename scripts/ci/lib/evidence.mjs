// Candidate evidence. Messages stay those of the topic 00 contract.
export function assertVerified(evidence) {
  if (evidence.status !== 'verified') throw new Error('task is not verified');
  if (!evidence.baseSha || !evidence.commands.length) {
    throw new Error('missing provenance or verification commands');
  }
  if (evidence.commands.some((command) => command.exitCode !== 0)) {
    throw new Error('unresolved failing verification');
  }
}

export function assertCandidateReady(sourceSha, artifactSet, checks) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !artifactSet) throw new Error('invalid candidate identity');
  const byId = new Map(checks.map((check) => [check.id, check]));
  if (byId.size !== checks.length) throw new Error('duplicate evidence');
  const required = [
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
  for (const id of required) {
    const evidence = byId.get(id);
    if (
      !evidence
      || evidence.status !== 'passed'
      || evidence.sourceSha !== sourceSha
      || evidence.artifactSet !== artifactSet
    ) {
      throw new Error(`missing, stale or failing evidence: ${id}`);
    }
  }
}
