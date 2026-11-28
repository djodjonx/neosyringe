export interface TaskEvidence {
  task: string;
  baseSha: string;
  resultSha?: string;
  status: 'planned' | 'implemented' | 'verified' | 'rejected-experiment';
  commands: readonly { command: string; exitCode: number; log: string }[];
  measurements: readonly {
    name: string;
    unit: string;
    samples: readonly number[];
    fixture: string;
    environment: string;
  }[];
  contractChanges: readonly string[];
  limitations: readonly string[];
}

export interface CheckEvidence {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'pending';
  readonly sourceSha: string;
  readonly artifactSet: string;
}

export function assertVerified(evidence: TaskEvidence): void;
export function assertCandidateReady(
  sourceSha: string,
  artifactSet: string,
  checks: readonly CheckEvidence[],
): void;
