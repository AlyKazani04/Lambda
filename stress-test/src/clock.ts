export interface ClockOffset {
  offsetMs: number;
  rttMs: number;
  measuredAt: string;
  source: string;
}

interface TimeResponse {
  now?: number;
}

async function fetchServerTime(
  collector: string,
): Promise<{ serverMs: number; rttMs: number }> {
  const before = Date.now();
  const res = await fetch(`${collector.replace(/\/+$/, '')}/time`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as TimeResponse;
  const after = Date.now();

  const serverMs = body.now;
  if (typeof serverMs !== 'number' || !Number.isFinite(serverMs)) {
    throw new Error('collector /time did not return a numeric "now"');
  }

  return { serverMs, rttMs: after - before };
}

export async function measureClockOffset(
  collector: string | null,
): Promise<ClockOffset> {
  const measuredAt = new Date().toISOString();

  if (collector === null) {
    return {
      offsetMs: 0,
      rttMs: 0,
      measuredAt,
      source: 'none (no --collector; local run assumes the same clock)',
    };
  }

  try {
    const samples: Array<{ offsetMs: number; rttMs: number }> = [];
    // Three samples, lowest RTT wins
    for (let i = 0; i < 3; i += 1) {
      const { serverMs, rttMs } = await fetchServerTime(collector);
      samples.push({ offsetMs: serverMs - (Date.now() - rttMs / 2), rttMs });
    }

    const best = samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
    return { ...best, measuredAt, source: collector };
  } catch (err) {
    // Must not abort the run
    return {
      offsetMs: 0,
      rttMs: 0,
      measuredAt,
      source: `unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
