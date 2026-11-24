export interface Summary {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly samples: readonly number[];
}

export interface ResolvedInstance {
  readonly value: number;
}

export interface BatchOp {
  prepare?: (k: number) => unknown;
  time: (state: unknown, k: number) => readonly unknown[] | Promise<readonly unknown[]>;
  check: (item: unknown, index: number) => void | Promise<void>;
  release?: (state: unknown, items: readonly unknown[]) => void | Promise<void>;
}

export interface BenchBatches {
  readonly create: BatchOp;
  readonly createScope: BatchOp;
  readonly initialize: BatchOp;
  readonly destroy: BatchOp;
  readonly 'cold-resolve': BatchOp;
}

export interface BenchHarness {
  readonly shape: string;
  readonly size: number;
  readonly coldIndex?: number;
  readonly resolvePerCall?: number;
  scopeDisposeCounts: () => readonly number[] | Promise<readonly number[]>;
  parentDisposeCounts?: () => readonly number[] | Promise<readonly number[]>;
  resolve?: (index: number) => ResolvedInstance;
  batches?: BenchBatches;
  heapAfterGc?: () => number | Promise<number>;
}

export interface MeasureInput {
  readonly createHarness: () => BenchHarness | Promise<BenchHarness>;
  readonly samples?: number;
  readonly batches?: number;
  readonly count?: number;
  readonly now?: () => number;
  readonly gc?: () => void;
  readonly minimumNs?: number;
  readonly fixedK?: Readonly<Record<string, number>>;
}

export interface CheckResult {
  readonly scopeCounts: readonly number[];
  readonly parentCounts: readonly number[];
}

export interface MetricSamples {
  readonly unit: string;
  readonly samples: readonly number[];
  readonly shortSamples?: number;
}

export interface BatchK {
  readonly create: number;
  readonly createScope: number;
  readonly initialize: number;
  readonly destroy: number;
  readonly 'cold-resolve': number;
  readonly 'warm-resolve': number;
}

export interface CalibratedResult extends CheckResult {
  readonly k: BatchK;
}

export interface TimedResult extends CheckResult {
  readonly k: BatchK;
  readonly metrics: {
    readonly create: MetricSamples;
    readonly 'warm-resolve': MetricSamples;
    readonly 'cold-resolve': MetricSamples;
    readonly createScope: MetricSamples;
    readonly initialize: MetricSamples;
    readonly destroy: MetricSamples;
    readonly heapAfterGc: MetricSamples;
  };
}

export const SAMPLE_MINIMUM_TICKS: number;
export const SAMPLE_MINIMUM_FLOOR_NS: number;

export function makeOrder(size: number, count: number, seed?: number): Uint32Array;
export function summarize(samples: readonly number[]): Summary;
export function timerResolutionNs(now?: () => number): number;
export function sampleMinimumNs(resolutionNs: number): number;
export function benchmarkResolve(input: {
  resolve: (index: number) => ResolvedInstance;
  size: number;
  count?: number;
  batches?: number;
  perCall?: number;
  now?: () => number;
  minimumNs?: number;
  fixedCount?: number;
  lockCount?: boolean;
}): Summary & {
  readonly metric: 'warm-resolve';
  readonly unit: 'ns/op';
  readonly count: number;
  readonly shortSamples: number;
};
export function verifyScopeRelease(counts: readonly number[]): void;
export function measureCase(input: MeasureInput): CheckResult | Promise<TimedResult>;
export function calibrateCase(input: MeasureInput): CalibratedResult | Promise<CalibratedResult>;
