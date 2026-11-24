export interface Summary {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly samples: readonly number[];
}

export interface ResolvedInstance {
  readonly value: number;
}

export interface BenchHarness {
  readonly shape: string;
  readonly size: number;
  readonly coldIndex?: number;
  readonly resolvePerCall?: number;
  scopeDisposeCounts: () => readonly number[] | Promise<readonly number[]>;
  parentDisposeCounts?: () => readonly number[] | Promise<readonly number[]>;
  resolve?: (index: number) => ResolvedInstance;
  recreate?: () => void | Promise<void>;
  settle?: () => void | Promise<void>;
  timeCreate?: () => number | Promise<number>;
  timeCreateScope?: () => number | Promise<number>;
  timeInitialize?: () => number | Promise<number>;
  timeDestroy?: () => number | Promise<number>;
  heapAfterGc?: () => number | Promise<number>;
}

export interface MeasureInput {
  readonly createHarness: () => BenchHarness | Promise<BenchHarness>;
  readonly samples?: number;
  readonly batches?: number;
  readonly count?: number;
}

export interface CheckResult {
  readonly scopeCounts: readonly number[];
  readonly parentCounts: readonly number[];
}

export interface MetricSamples {
  readonly unit: string;
  readonly samples: readonly number[];
}

export interface TimedResult extends CheckResult {
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

export function makeOrder(size: number, count: number, seed?: number): Uint32Array;
export function summarize(samples: readonly number[]): Summary;
export function benchmarkResolve(input: {
  resolve: (index: number) => ResolvedInstance;
  size: number;
  count?: number;
  batches?: number;
  perCall?: number;
}): Summary & { readonly metric: 'warm-resolve'; readonly unit: 'ns/op' };
export function verifyScopeRelease(counts: readonly number[]): void;
export function measureCase(input: MeasureInput): CheckResult | Promise<TimedResult>;
