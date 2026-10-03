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
 * Ceiling on any caller-supplied delay or count.
 *
 * `?ms=999999999` would otherwise pin a socket open indefinitely, and the load
 * generator drives these endpoints in the thousands — unbounded timers are a
 * resource-exhaustion vector (CodeQL js/resource-exhaustion flags the unclamped
 * form). 30s is far beyond any latency worth plotting against a P99 target of
 * 200ms, and still lets a request terminate on its own.
 */
const MAX_DELAY_MS = 30_000;

/** Same ceiling for ?n= on the chunked endpoint: each chunk is one timer. */
const MAX_CHUNKS = 512;

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
  const requested = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  const delay = Math.min(requested, MAX_DELAY_MS);
  if (delay !== requested) {
    console.warn(`slow: clamped ${requested}ms to ${delay}ms`);
  }
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
  // Clamped for the same reason as the delay: each chunk schedules its own
  // timer, so an unbounded ?n= is a way to pin the event loop indefinitely.
  const requested = Number.isFinite(chunks) && chunks > 0 ? Math.floor(chunks) : 5;
  const count = Math.min(requested, MAX_CHUNKS);
  if (count !== requested) {
    console.warn(`chunked: clamped ${requested} chunks to ${count}`);
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
