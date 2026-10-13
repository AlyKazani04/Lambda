import { measureClockOffset } from './clock.js';
import { HELP, parseArgs, UsageError } from './config.js';
import { runLoad } from './generator.js';
import { report } from './reporter.js';
import type { RunSummary } from './generator.js';

function us(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}ms` : `${value.toFixed(0)}us`;
}

function printSummary(summary: RunSummary): void {
  const { latency } = summary;

  console.log('\n=== run summary ===');
  console.log(`label           ${summary.label}`);
  console.log(`target          ${summary.target}`);
  console.log(`seed            ${summary.seed}`);
  console.log(`workers         ${summary.workers}`);
  console.log(`concurrency     ${summary.concurrency}`);
  console.log(`ramp            ${summary.rampMs}ms`);
  console.log(`duration        ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`started         ${summary.startedAt}`);
  console.log(`clock offset    ${summary.clock.offsetMs.toFixed(1)}ms ` + `(rtt ${summary.clock.rttMs}ms, ${summary.clock.source})`);

  console.log('\n--- throughput ---');
  console.log(`requests        ${summary.requests}`);
  console.log(`req/s           ${summary.requestsPerSecond.toFixed(1)}`);
  console.log(`ok              ${summary.ok}`);
  console.log(`errors          ${summary.errors}`);
  console.log(`error rate      ${(summary.errorRate * 100).toFixed(2)}%`);
  console.log(`bytes in/out    ${summary.bytesIn} / ${summary.bytesOut}`);

  console.log('\n--- latency (body bytes, client-side) ---');
  console.log(`count           ${latency.count}`);
  console.log(`min             ${us(latency.minUs)}`);
  console.log(`mean            ${us(latency.meanUs)}`);
  console.log(`p50             ${us(latency.p50Us)}`);
  console.log(`p90             ${us(latency.p90Us)}`);
  console.log(`p99             ${us(latency.p99Us)}`);
  console.log(`max             ${us(latency.maxUs)}`);

  console.log('\n--- status counts ---');
  for (const [status, count] of Object.entries(summary.statusCounts).sort()) {
    console.log(`  ${status.padEnd(10)} ${count}`);
  }

  console.log('\n--- scenario mix (configured vs observed) ---');
  for (const scenario of summary.table.scenarios) {
    const observed = summary.scenarioMix[scenario.name] ?? 0;
    const delta = Math.abs(observed - scenario.weight);
    console.log(
      `  ${scenario.name.padEnd(15)} want ${String(scenario.weight).padStart(3)}%  ` +
      `got ${observed.toFixed(2).padStart(6)}%  d${delta.toFixed(2)}`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const config = parseArgs(argv);

  const clock = await measureClockOffset(config.collector);
  if (config.collector !== null) {
    console.log(
      `clock offset vs collector: ${clock.offsetMs.toFixed(1)}ms ` +
      `(rtt ${clock.rttMs}ms, ${clock.source})`,
    );
  }

  const summary = await runLoad(config, clock);
  printSummary(summary);
  await report(summary, config.collector);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`error: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
