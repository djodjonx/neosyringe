export interface Distribution {
  readonly median: number;
  readonly mad: number;
  readonly samples: readonly number[];
}

export interface BudgetVerdict {
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly ratio: number;
  readonly noise: number;
}

export interface BenchEnvironment {
  readonly node: string;
  readonly typescript: string;
  readonly sha: string;
  readonly dirty: boolean;
  readonly cpu: string;
  readonly cores: number;
  readonly memory: number;
  readonly os: string;
  readonly flags: string;
}

export interface MetricReport {
  readonly unit: string;
  readonly processes: readonly (readonly number[])[];
  readonly processMedians: readonly number[];
  readonly median: number;
  readonly mad: number;
}

export interface BenchCase {
  readonly shape: string;
  readonly profile: string;
  readonly mode: string;
  readonly size: number;
  readonly checksum?: number;
  readonly buildMs?: number;
  readonly module?: { readonly raw: number; readonly min: number; readonly gzip: number };
  readonly error?: string;
  readonly metrics?: Readonly<Record<string, MetricReport>>;
}

export interface BenchReport {
  readonly environment: BenchEnvironment;
  readonly params: Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>;
  readonly cases: readonly BenchCase[];
}

export function distribution(samples: readonly number[]): Distribution;
export function compareBudget(baseline: Distribution, candidate: Distribution): BudgetVerdict;
export function assertReport(baseline: BenchReport, candidate: BenchReport): readonly string[];
