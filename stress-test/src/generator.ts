import { Worker } from 'node:worker_threads';

import {
  createHistogram,
  merge,
  summarize,
  type LatencySummary,
  type WorkerReport,
} from './aggregator.js';
import type { RunConfig } from './config.js';
import type { ClockOffset } from './clock.js';
import { report } from './reporter.js';
import type { WeightedTable } from './scenarios.js';

export type LoopMode = 'closed' | 'open';

export interface RunSummary {
  label: string;
  target: string;
  seed: number;
  workers: number;
  concurrency: number;
  rampMs: number;
  durationMs: number;
  startedAt: string;
  elapsedMs: number;
  requests: number;
  ok: number;
  errors: number;
  errorRate: number;
  requestsPerSecond: number;
  statusCounts: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
  latency: LatencySummary;
  clock: ClockOffset;
  scenarioMix: Record<string, number>;
  // Closed-loop caps in-flight requests, so a slow server throttles the generator. Stated explicitly
  loop: LoopMode;
  table: WeightedTable;
}

interface WorkerMessage {
  type: 'progress' | 'done' | 'snapshot';
  workerIndex: number;
  concurrency?: number;
  requests?: number;
  report?: WorkerReport;
}

interface SpawnedWorker {
  worker: Worker;
  ready: Promise<void>;
  done: Promise<WorkerReport>;
  snapshot: () => Promise<WorkerReport | null>;
}

function workerUrl(): URL {
  return new URL('./worker.js', import.meta.url);
}

// All workers ready before startAt, so thread startup is never in the timing window
function spawnWorker(config: RunConfig, index: number, startAt: number): SpawnedWorker {
  const worker = new Worker(workerUrl(), {
    workerData: {
      target: config.target,
      workerIndex: index,
      workerCount: config.workers,
      durationMs: config.durationMs,
      concurrency: config.concurrency,
      rampMs: config.rampMs,
      seed: config.seed,
      table: config.table,
      startAt,
    },
  });

  let resolveReady: () => void = () => { };
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let resolveSnapshot: ((report: WorkerReport | null) => void) | null = null;

  const done = new Promise<WorkerReport>((resolve, reject) => {
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') {
        console.log(
          `  [worker ${message.workerIndex}] concurrency=${message.concurrency} requests=${message.requests}`,
        );
        return;
      }
      if (message.type === 'snapshot' && resolveSnapshot !== null) {
        resolveSnapshot(message.report ?? null);
        resolveSnapshot = null;
        return;
      }
      if (message.type === 'done' && message.report !== undefined) {
        resolve(message.report);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker ${index} exited with code ${code}`));
    });
  });

  // online triggers on thread up, before startAt releases it
  worker.on('online', () => resolveReady());

  const snapshot = (): Promise<WorkerReport | null> =>
    new Promise((resolve) => {
      // A worker already past its deadline will not answer; time out and drop it.
      const timer = setTimeout(() => {
        resolveSnapshot = null;
        resolve(null);
      }, 2000);
      resolveSnapshot = (report) => {
        clearTimeout(timer);
        resolve(report);
      };
      worker.postMessage({ type: 'snapshot' });
    });

  return { worker, ready, done, snapshot };
}

interface Tally {
  requests: number;
  ok: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
  statusCounts: Record<string, number>;
  scenarioCounts: Record<string, number>;
  histogram: Int32Array;
}

function emptyTally(): Tally {
  return {
    requests: 0,
    ok: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    statusCounts: {},
    scenarioCounts: {},
    histogram: createHistogram(),
  };
}

function fold(tally: Tally, reports: ReadonlyArray<WorkerReport>): Tally {
  for (const report of reports) {
    merge(tally.histogram, Int32Array.from(report.histogram));
    tally.requests += report.requests;
    tally.ok += report.ok;
    tally.errors += report.errors;
    tally.bytesIn += report.bytesIn;
    tally.bytesOut += report.bytesOut;
    for (const [status, count] of Object.entries(report.statusCounts)) {
      tally.statusCounts[status] = (tally.statusCounts[status] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(report.scenarioCounts)) {
      tally.scenarioCounts[name] = (tally.scenarioCounts[name] ?? 0) + count;
    }
  }
  return tally;
}

function toSummary(
  config: RunConfig,
  clock: ClockOffset,
  tally: Tally,
  startedAt: string,
  elapsedMs: number,
): RunSummary {
  const seconds = Math.max(elapsedMs, 1) / 1000;

  return {
    label: config.label,
    target: config.target,
    seed: config.seed,
    workers: config.workers,
    concurrency: config.concurrency,
    rampMs: config.rampMs,
    durationMs: config.durationMs,
    startedAt,
    elapsedMs,
    requests: tally.requests,
    ok: tally.ok,
    errors: tally.errors,
    errorRate: tally.requests === 0 ? 0 : tally.errors / tally.requests,
    requestsPerSecond: tally.requests / seconds,
    statusCounts: tally.statusCounts,
    bytesIn: tally.bytesIn,
    bytesOut: tally.bytesOut,
    latency: summarize(tally.histogram),
    clock,
    scenarioMix: Object.fromEntries(
      Object.entries(tally.scenarioCounts).map(([name, count]) => [
        name,
        tally.requests === 0 ? 0 : (count / tally.requests) * 100,
      ]),
    ),
    loop: 'closed',
    table: config.table,
  };
}

export async function runLoad(
  config: RunConfig,
  clock: ClockOffset,
): Promise<RunSummary> {
  // Workers wait until startAt
  const startAt = Date.now() + 500;
  const startedAt = new Date(startAt).toISOString();

  const workers = Array.from({ length: config.workers }, (_, index) =>
    spawnWorker(config, index, startAt),
  );

  await Promise.all(workers.map((w) => w.ready));

  console.log(
    `running: ${config.workers} workers, concurrency ${config.concurrency}, ` +
    `duration ${config.durationMs}ms, ramp ${config.rampMs}ms, seed ${config.seed}`,
  );

  // Periodic progress reports, so the collector sees the run build up
  let stopReporting = false;
  const reportingLoop = (async () => {
    if (config.collector === null || config.reportIntervalMs <= 0) return;

    while (!stopReporting) {
      await new Promise((resolve) => setTimeout(resolve, config.reportIntervalMs));
      if (stopReporting) return;

      const snaps = await Promise.all(workers.map((w) => w.snapshot()));
      const reports = snaps.filter((r): r is WorkerReport => r !== null);
      if (reports.length === 0) continue;

      const summary = toSummary(
        config,
        clock,
        fold(emptyTally(), reports),
        startedAt,
        Date.now() - startAt,
      );
      const ok = await report(summary, config.collector, 'progress', true);
      console.log(
        `  progress report: ${summary.requests} requests, ` +
        `${summary.requestsPerSecond.toFixed(0)} req/s${ok ? '' : ' (not delivered)'}`,
      );
    }
  })();

  const reports = await Promise.all(workers.map((w) => w.done));
  stopReporting = true;
  await reportingLoop;
  await Promise.all(workers.map((w) => w.worker.terminate()));

  return toSummary(
    config,
    clock,
    fold(emptyTally(), reports),
    startedAt,
    config.durationMs,
  );
}
