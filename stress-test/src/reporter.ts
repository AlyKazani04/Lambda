import type { RunSummary } from './generator.js';

export async function report(
  summary: RunSummary,
  collector: string | null,
): Promise<void> {
  if (collector === null) {
    console.log('no --collector set; report not shipped');
    return;
  }

  const url = `${collector.replace(/\/+$/, '')}/aggregates`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`collector rejected the report: ${res.status} ${res.statusText}`);
      return;
    }
    console.log(`report shipped to ${url}`);
  } catch (err) {
    console.error(
      `could not reach collector at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
