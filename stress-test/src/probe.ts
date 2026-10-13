export interface ProbeResult {
  status: number;
  latencyUs: number;
  bytesIn: number;
  bytesOut: number;
};

export async function fireRequest(url: URL | string, init?: { method?: string, body?: string }): Promise<ProbeResult> {
  const body = init?.body;
  const bytesOut = body === undefined ? 0 : Buffer.byteLength(body);

  const start: number = performance.now();

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

  const latencyUs: number = (performance.now() - start) * 1000;

  return { status, latencyUs, bytesIn, bytesOut };
}

