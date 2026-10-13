import { parentPort, workerData } from 'node:worker_threads';

import { createHistogram, record, type WorkerReport } from './aggregator.js';
import { fireRequest } from './probe.js';
import {
  bodyFor,
  pickFrom,
  queryFor,
  rand,
  type WeightedTable,
} from './scenarios.js';

interface WorkerInit {
  target: string;
  workerIndex: number;
  workerCount: number;
  durationMs: number;
  concurrency: number;
  rampMs: number;
  seed: number;
  table: WeightedTable;
  startAt: number;
}

const init = workerData as WorkerInit;

if (parentPort === null) {
  throw new Error('worker.ts must be run as a worker thread');
}
const port = parentPort;

port.on('message', (message: { type?: string }) => {
  if (message.type !== 'snapshot') return;
  port.postMessage({
    type: 'snapshot',
    workerIndex: init.workerIndex,
    report: currentReport(),
  });
});

// Per worker stream derived from the run seed, reproducible
const rng = rand((init.seed + init.workerIndex * 7919) >>> 0);
const histogram = createHistogram();

const statusCounts: Record<string, number> = {};
const scenarioCounts: Record<string, number> = {};
let requests = 0;
let ok = 0;
let errors = 0;
let bytesIn = 0;
let bytesOut = 0;

async function fireOne(): Promise<void> {
  const scenario = pickFrom(rng, init.table);
  const result = await fireRequest(
    `${init.target}${scenario.path}${queryFor(scenario)}`,
    { method: scenario.method, body: bodyFor(scenario) },
  );

  requests += 1;
  scenarioCounts[scenario.name] = (scenarioCounts[scenario.name] ?? 0) + 1;
  bytesIn += result.bytesIn;
  bytesOut += result.bytesOut;
  record(histogram, result.latencyUs);

  const key = result.error !== null ? 'transport' : String(result.status);
  statusCounts[key] = (statusCounts[key] ?? 0) + 1;

  if (result.error === null && result.status < 500) {
    ok += 1;
  } else {
    errors += 1;
  }
}

// Share of target concurrency climbs 1 -> ceiling over rampMs
function shareAt(elapsedMs: number): number {
  const ceiling = Math.max(1, Math.round(init.concurrency / init.workerCount));
  if (init.rampMs <= 0) return ceiling;

  const progress = Math.min(1, elapsedMs / init.rampMs);
  return Math.max(1, Math.ceil(ceiling * progress));
}

async function run(): Promise<void> {
  const deadline = init.startAt + init.durationMs;
  const inFlight = new Set<Promise<void>>();
  let lastReport = init.startAt;

  while (Date.now() < deadline) {
    const target = shareAt(Date.now() - init.startAt);

    while (inFlight.size < target) {
      const task = fireOne().finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }

    if (Date.now() - lastReport >= 1000) {
      lastReport = Date.now();
      port.postMessage({
        type: 'progress',
        workerIndex: init.workerIndex,
        concurrency: inFlight.size,
        requests,
      });
    }

    // Yield so the loop can service sockets. Without this the while loop spinss
    await new Promise((resolve) => setImmediate(resolve));
  }

  await Promise.all(inFlight);
}

await run();

// Read at call time, so a snapshot mid run reflects what has been recorded so far
function currentReport(): WorkerReport {
  return {
    histogram: Array.from(histogram),
    requests,
    ok,
    errors,
    statusCounts: { ...statusCounts },
    scenarioCounts: { ...scenarioCounts },
    bytesIn,
    bytesOut,
  };
}

port.postMessage({ type: 'done', workerIndex: init.workerIndex, report: currentReport() });
