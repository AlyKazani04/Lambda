export interface ProbeResult {
  status: number;
  latencyUs: number;
  bytesIn: number;
  bytesOut: number;
  error: string | null;
}

export interface ProbeInit {
  method?: string;
  body?: string;
}

// status 0 = transport failure
export async function fireRequest(
  url: URL | string,
  init?: ProbeInit,
): Promise<ProbeResult> {
  const body = init?.body;
  const bytesOut = body === undefined ? 0 : Buffer.byteLength(body);

  const start = performance.now();

  try {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      ...(body === undefined ? {} : { body }),
    });

    const status = res.status;

    let bytesIn = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesIn += value.byteLength;
      }
    }

    // Draining to done returns the socket to the pool, returning early leaks it
    return {
      status,
      latencyUs: (performance.now() - start) * 1000,
      bytesIn,
      bytesOut,
      error: null,
    };
  } catch (err) {
    // Failure still has latency and the tail sample matters; dropping it biases P99 down.
    return {
      status: 0,
      latencyUs: (performance.now() - start) * 1000,
      bytesIn: 0,
      bytesOut,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
