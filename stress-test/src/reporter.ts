import type { RunSummary } from './generator.js';

export type ReportPhase = 'progress' | 'final';

// progress is a partial snapshot for the live dashboard, final is an end-of-run summary and must not be overwritten
export interface ReportPayload {
  phase: ReportPhase;
  summary: RunSummary;
}

// Never Redis: Pub/Sub does not cross machines and a remote publish fails silently.
export async function report(
  summary: RunSummary,
  collector: string | null,
  phase: ReportPhase = 'final',
  quiet = false,
): Promise<boolean> {
  if (collector === null) {
    if (!quiet) console.log('no --collector set; report not shipped');
    return false;
  }

  const url = `${collector.replace(/\/+$/, '')}/aggregates`;

  try {
    const payload: ReportPayload = { phase, summary };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (!quiet) {
        console.error(`collector rejected the report: ${res.status} ${res.statusText}`);
      }
      return false;
    }
    if (!quiet) console.log(`report shipped to ${url} (phase=${phase})`);
    return true;
  } catch (err) {
    // Delivery failure is not run failure
    console.error(
      `could not reach collector at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
