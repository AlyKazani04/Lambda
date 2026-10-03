// Engineered network phenomena (F3).
//
// Each function produces a *specific, reproducible* transport-layer event, so
// that Track B's capture work has something real to observe and two runs are
// comparable. Determinism matters more than realism here: an unseeded rotation
// would make every measurement incomparable, and comparison is the point.

import type { ServerResponse } from 'node:http';

import type { Behaviour } from './scenarios.js';

/**
 * The rotation cycles every error path we want the proxy to survive. A proxy
 * that mishandles a 429 is a real bug, and a service that only ever returns
 * 200 would never surface it.
 */
export const STATUS_CYCLE = [200, 201, 400, 401, 404, 429, 500] as const;

export const SMALL_BYTES = 1024;
export const LARGE_BYTES = 100 * 1024;

/**
 * Chunk counts the stub will actually stream. Fixed set for the same reason as
 * ALLOWED_DELAYS_MS: one timer per chunk, so the count must not be arbitrary.
 * 500 is well past anything useful for demonstrating multi-segment frames.
 */
const ALLOWED_CHUNKS: ReadonlyArray<number> = [2, 3, 5, 8, 10, 16, 32, 64, 128, 256, 500];

/**
 * The only delays this service will ever hold a socket open for.
 *
 * `?ms=` is caller-controlled and reaches `setTimeout`, so an arbitrary value
 * is a resource-exhaustion vector: `?ms=999999999` would pin the socket open
 * indefinitely, and the load generator drives this endpoint in the thousands
 * (CodeQL js/resource-exhaustion).
 *
 * Snapping to an allowlist rather than clamping with `Math.min` is deliberate.
 * A clamp still derives the duration from user input, so the flow reaches
 * `setTimeout` and the alert stays open; selecting from a fixed set means the
 * value cannot be user-controlled at all. It is also the better behaviour for
 * the load generator — a P99 is only comparable across runs if every run draws
 * from the same set of latencies.
 */
const ALLOWED_DELAYS_MS: ReadonlyArray<number> = [
  0, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000,
];

/** Nearest allowed delay. Always a member of ALLOWED_DELAYS_MS. */
export function resolveDelay(ms: number): number {
  let nearest = ALLOWED_DELAYS_MS[0] ?? 0;
  if (!Number.isFinite(ms) || ms < 0) {
    return nearest;
  }
  for (const candidate of ALLOWED_DELAYS_MS) {
    if (Math.abs(candidate - ms) < Math.abs(nearest - ms)) {
      nearest = candidate;
    }
  }
  return nearest;
}

// Endpoint contract, for whoever writes the load generator (#9 / F4):
//
//   /api/status          rotating 200/201/400/401/404/429/500, in order
//   /api/small           ~1 KB JSON
//   /api/large           ~100 KB JSON
//   /api/slow?ms=N       delay N ms, snapped to a fixed set (0..5000)
//   /api/reset           socket destroyed mid-response -> RST
//   /api/close           Connection: close -> extra handshakes
//   /api/chunked?n=N     N chunks ~5ms apart, snapped to a fixed set
//   /api/burst           plain 200; burst rate is the generator's job
//   /timeline/*          ~1 KB JSON
//
// Any of these can be overridden per request with ?behaviour=<name>, which is
// how the generator drives a weighted distribution.
//
// Delays and chunk counts snap to the nearest allowed value rather than being
// honoured exactly: ?ms=999999999 becomes 5000, ?n=1000000000 becomes 500.
// Both are caller-controlled and each drives a timer, so an arbitrary value is
// a resource-exhaustion vector. The response echoes the value actually used,
// so a run's latencies are self-documenting.

/** Delay between streamed chunks. Without it the kernel coalesces the whole
 * body into one segment and there is nothing for B7 to reassemble. */
const CHUNK_GAP_MS = 5;

/**
 * Request counter shared across the process. Status rotation is driven off
 * this rather than a RNG so a given request sequence always yields the same
 * status sequence.
 */
let statusCursor = 0;

/** Requests served so far. Doubles as the status-rotation position. */
export function servedCount(): number {
  return statusCursor;
}

export function resetStatusCursor(): void {
  statusCursor = 0;
}

export function nextRotatingStatus(): number {
  // Index is bounded by construction: modulo of a non-negative int into a
  // fixed tuple. noUncheckedIndexedAccess still needs the assertion.
  const status = STATUS_CYCLE[statusCursor % STATUS_CYCLE.length] ?? 200;
  statusCursor += 1;
  return status;
}

/** Filler that pads a response to a target size, so byte counts are exact. */
function filler(bytes: number): string {
  return 'x'.repeat(Math.max(0, bytes));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function behaviourOk(res: ServerResponse, path: string): void {
  sendJson(res, 200, { stub: true, path });
}

export function behaviourStatus(res: ServerResponse, path: string): void {
  const status = nextRotatingStatus();
  sendJson(res, status, { stub: true, path, status, index: statusCursor });
}

export function behaviourSmall(res: ServerResponse, path: string): void {
  const envelope = JSON.stringify({ stub: true, path, size: 'small' });
  const body = envelope.padEnd(SMALL_BYTES, 'x');
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function behaviourLarge(res: ServerResponse, path: string): void {
  const envelope = JSON.stringify({ stub: true, path, size: 'large' });
  const body = envelope.padEnd(LARGE_BYTES, 'x');
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Hold the response open for `ms`. This is what gives us a latency
 * distribution and a P99 instead of one meaningless average.
 *
 * The duration is caller-controlled, so it is clamped. `?ms=999999999` would
 * otherwise pin a socket open indefinitely — the load generator drives this
 * endpoint in the thousands, and unbounded timers are a resource-exhaustion
 * vector (CodeQL js/resource-exhaustion flags the unclamped form). A day is far
 * beyond any latency worth plotting and still terminates on its own.
 */
export function behaviourSlow(
  res: ServerResponse,
  path: string,
  ms: number,
): void {
  const delay = resolveDelay(ms);
  setTimeout(() => {
    sendJson(res, 200, { stub: true, path, delayedMs: delay });
  }, delay);
}

/**
 * Destroy the socket mid-response so the client and the proxy both see a TCP
 * RST on the wire. This is the clearest demonstration that an application-layer
 * action causes a specific transport-layer event.
 *
 * The destroy MUST happen after headers and at least one body chunk have been
 * flushed. Destroying before any write may put no RST on the wire at all, and
 * B10 then sees nothing.
 */
export function behaviourReset(res: ServerResponse, _path: string): void {
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': LARGE_BYTES,
  });
  // Promise resolves once the chunk has actually left, so the reset lands
  // mid-body rather than after a complete response.
  res.write(filler(256), () => {
    setTimeout(() => {
      const socket = res.socket;
      if (!socket) return;
      // resetAndDestroy sets SO_LINGER 0, which makes the kernel emit RST.
      // A plain destroy() is not enough: with an empty receive queue it sends
      // a clean FIN, the client sees a truncated body rather than a reset, and
      // B10's RST detection finds nothing. This is the single most valuable
      // endpoint in the stub, so it has to actually put a RST on the wire.
      if (typeof socket.resetAndDestroy === 'function') {
        socket.resetAndDestroy();
      } else {
        socket.destroy();
      }
    }, CHUNK_GAP_MS);
  });
}

/**
 * Force `Connection: close` so the connection is torn down after each
 * response. TCP handshakes then outnumber HTTP requests, which is what makes
 * B3's handshake timing observable in the dashboard.
 */
export function behaviourClose(res: ServerResponse, path: string): void {
  const payload = JSON.stringify({ stub: true, path, close: true });
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  res.end(payload);
}

/**
 * Stream the body in N chunks. Response frames then span multiple TCP
 * segments, which is what gives B7's reassembly work something to reassemble.
 */
export function behaviourChunked(
  res: ServerResponse,
  path: string,
  chunks: number,
): void {
  // Same reasoning as the delay: selecting from a fixed set means the chunk
  // count cannot be user-controlled at all, which is what actually closes the
  // resource-exhaustion path (an unbounded ?n= is one timer per chunk).
  let count = ALLOWED_CHUNKS[0] ?? 5;
  if (Number.isFinite(chunks) && chunks > 0) {
    for (const candidate of ALLOWED_CHUNKS) {
      if (Math.abs(candidate - chunks) < Math.abs(count - chunks)) {
        count = candidate;
      }
    }
  }
  const envelope = JSON.stringify({ stub: true, path, chunks: count });
  const body = envelope.padEnd(LARGE_BYTES, 'x');
  const size = Math.ceil(body.length / count);

  res.writeHead(200, {
    'content-type': 'application/json',
    'transfer-encoding': 'chunked',
  });

  let sent = 0;
  const writeNext = (): void => {
    if (sent >= count) {
      res.end();
      return;
    }
    const slice = body.slice(sent * size, (sent + 1) * size);
    sent += 1;
    res.write(slice);
    // The gap is load-bearing. Chunks written back-to-back in the same tick
    // get coalesced by the kernel into a single segment.
    setTimeout(writeNext, CHUNK_GAP_MS);
  };
  writeNext();

  res.on('error', () => {
    /* client hung up mid-stream */
  });
}

/** Dispatch to the behaviour named by the resolved scenario. */
export function apply(
  behaviour: Behaviour,
  res: ServerResponse,
  path: string,
  params: URLSearchParams,
): void {
  switch (behaviour) {
    case 'status':
      behaviourStatus(res, path);
      return;
    case 'small':
      behaviourSmall(res, path);
      return;
    case 'large':
      behaviourLarge(res, path);
      return;
    case 'slow':
      behaviourSlow(res, path, Number(params.get('ms') ?? 250));
      return;
    case 'reset':
      behaviourReset(res, path);
      return;
    case 'close':
      behaviourClose(res, path);
      return;
    case 'chunked':
      behaviourChunked(res, path, Number(params.get('n') ?? 5));
      return;
    case 'ok':
      behaviourOk(res, path);
      return;
  }
}
