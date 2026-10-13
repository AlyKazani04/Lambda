export const TIERS = [
  { upperUs: 10_000, widthUs: 50 },
  { upperUs: 100_000, widthUs: 500 },
  { upperUs: 1_000_000, widthUs: 5_000 },
  { upperUs: 10_000_000, widthUs: 50_000 },
] as const;

function bucketEdges(): number[] {
  const edges: number[] = [];
  let lower = 0;

  for (const tier of TIERS) {
    for (let edge = lower + tier.widthUs; edge <= tier.upperUs; edge += tier.widthUs) {
      edges.push(edge);
    }
    lower = tier.upperUs;
  }

  edges.push(Number.POSITIVE_INFINITY);
  return edges;
}

export const EDGES: ReadonlyArray<number> = bucketEdges();

export const BUCKET_COUNT = EDGES.length;

// Int32Array so it can be copied into a worker or SAB slice without conversion
export type Histogram = Int32Array;

export function createHistogram(): Histogram {
  return new Int32Array(BUCKET_COUNT);
}

// First edge >= us. Last edge is +Infinity
export function bucketIndex(latencyUs: number): number {
  let lo = 0;
  let hi = BUCKET_COUNT - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((EDGES[mid] as number) >= latencyUs) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  return lo;
}

export function record(histogram: Histogram, latencyUs: number): void {
  const index = bucketIndex(latencyUs < 0 ? 0 : latencyUs);
  histogram[index] = (histogram[index] ?? 0) + 1;
}

export function merge(target: Histogram, source: Histogram): void {
  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    target[i] = (target[i] ?? 0) + (source[i] ?? 0);
  }
}

export function totalCount(histogram: Histogram): number {
  let total = 0;
  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    total += histogram[i] ?? 0;
  }
  return total;
}

// Walk buckets until p * total is passed and report that upper edge overestimates by <=1 bucket
export function percentile(histogram: Histogram, p: number): number {
  const total = totalCount(histogram);
  if (total === 0) return 0;

  const target = p * total;
  let seen = 0;

  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    seen += histogram[i] ?? 0;
    if (seen >= target) {
      const edge = EDGES[i] as number;
      return Number.isFinite(edge) ? edge : (EDGES[i - 1] as number);
    }
  }

  return EDGES[BUCKET_COUNT - 2] as number;
}

export function meanUs(histogram: Histogram): number {
  const total = totalCount(histogram);
  if (total === 0) return 0;

  let sum = 0;
  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    const count = histogram[i] ?? 0;
    if (count === 0) continue;
    const edge = EDGES[i] as number;
    sum += count * (Number.isFinite(edge) ? edge : (EDGES[i - 1] as number));
  }

  return sum / total;
}

export interface LatencySummary {
  count: number;
  minUs: number;
  meanUs: number;
  p50Us: number;
  p90Us: number;
  p99Us: number;
  maxUs: number;
}

export function minUs(histogram: Histogram): number {
  for (let i = 0; i < BUCKET_COUNT; i += 1) {
    if ((histogram[i] ?? 0) > 0) {
      const lower = i === 0 ? 0 : (EDGES[i - 1] as number);
      return Number.isFinite(lower) ? lower : 0;
    }
  }
  return 0;
}

export function maxUs(histogram: Histogram): number {
  for (let i = BUCKET_COUNT - 1; i >= 0; i -= 1) {
    if ((histogram[i] ?? 0) > 0) {
      const edge = EDGES[i] as number;
      return Number.isFinite(edge) ? edge : (EDGES[i - 1] as number);
    }
  }
  return 0;
}

export function summarize(histogram: Histogram): LatencySummary {
  return {
    count: totalCount(histogram),
    minUs: minUs(histogram),
    meanUs: meanUs(histogram),
    p50Us: percentile(histogram, 0.5),
    p90Us: percentile(histogram, 0.9),
    p99Us: percentile(histogram, 0.99),
    maxUs: maxUs(histogram),
  };
}

// Histogram as a plain array plus the nonhistogram counters
export interface WorkerReport {
  histogram: number[];
  requests: number;
  ok: number;
  errors: number;
  statusCounts: Record<string, number>;
  scenarioCounts: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
}

export function mergeReports(reports: ReadonlyArray<WorkerReport>): WorkerReport {
  const histogram = createHistogram();
  let requests = 0;
  let ok = 0;
  let errors = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const statusCounts: Record<string, number> = {};
  const scenarioCounts: Record<string, number> = {};

  for (const report of reports) {
    for (let i = 0; i < BUCKET_COUNT; i += 1) {
      histogram[i] = (histogram[i] ?? 0) + (report.histogram[i] ?? 0);
    }
    requests += report.requests;
    ok += report.ok;
    errors += report.errors;
    bytesIn += report.bytesIn;
    bytesOut += report.bytesOut;
    for (const [status, count] of Object.entries(report.statusCounts)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(report.scenarioCounts)) {
      scenarioCounts[name] = (scenarioCounts[name] ?? 0) + count;
    }
  }

  return {
    histogram: Array.from(histogram),
    requests,
    ok,
    errors,
    statusCounts,
    scenarioCounts,
    bytesIn,
    bytesOut,
  };
}
