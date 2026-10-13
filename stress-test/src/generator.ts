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
import type { WeightedTable } from './scenarios.js';

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
  table: WeightedTable;
}

interface WorkerMessage {
  type: 'progress' | 'done';
  workerIndex: number;
  concurrency?: number;
  requests?: number;
  report?: WorkerReport;
}

function workerUrl(): URL {
  return new URL('./worker.js', import.meta.url);
}

// All workers ready before startAt, so thread startup is never in the timing window.
function spawnWorker(config: RunConfig, index: number, startAt: number): {
  worker: Worker;
  ready: Promise<void>;
  done: Promise<WorkerReport>;
} {
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

  const done = new Promise<WorkerReport>((resolve, reject) => {
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'progress') {
        console.log(
          `  [worker ${message.workerIndex}] concurrency=${message.concurrency} requests=${message.requests}`,
        );
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

  return { worker, ready, done };
}

export async function runLoad(
  config: RunConfig,
  clock: ClockOffset,
): Promise<RunSummary> {
  // Workers wait until startAt
  const startAt = Date.now() + 500;

  const workers = Array.from({ length: config.workers }, (_, index) =>
    spawnWorker(config, index, startAt),
  );

  await Promise.all(workers.map((w) => w.ready));

  console.log(
    `running: ${config.workers} workers, concurrency ${config.concurrency}, ` +
    `duration ${config.durationMs}ms, ramp ${config.rampMs}ms, seed ${config.seed}`,
  );

  const reports = await Promise.all(workers.map((w) => w.done));
  await Promise.all(workers.map((w) => w.worker.terminate()));

  const merged = createHistogram();
  let requests = 0;
  let ok = 0;
  let errors = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const statusCounts: Record<string, number> = {};
  const scenarioCounts: Record<string, number> = {};

  for (const report of reports) {
    merge(merged, Int32Array.from(report.histogram));
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

  const elapsedMs = config.durationMs;
  const startedAt = new Date(startAt).toISOString();

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
    requests,
    ok,
    errors,
    errorRate: requests === 0 ? 0 : errors / requests,
    requestsPerSecond: requests / (elapsedMs / 1000),
    statusCounts,
    bytesIn,
    bytesOut,
    latency: summarize(merged),
    clock,
    scenarioMix: Object.fromEntries(
      Object.entries(scenarioCounts).map(([name, count]) => [
        name,
        requests === 0 ? 0 : (count / requests) * 100,
      ]),
    ),
    table: config.table,
  };
}
