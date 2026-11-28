import { performance } from 'node:perf_hooks';
import type { IncomingMessage } from 'node:http';

import type { FrameBus } from '../bus/redis.js';
import type { FrameTlsMode } from 'shared-types';

export interface FrameRecorderOptions {
  bus: FrameBus;
  traceId: string;
  method: string;
  path: string;
  group: string;
  upstream: string;
  /** A8: set on the TLS path so plaintext and TLS frames share one logger. */
  tlsMode?: FrameTlsMode;
  sni?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** Credential headers stay masked unless this is explicitly enabled. */
  logSecrets?: boolean;
  /** Injectable clock for deterministic tests; defaults to performance.now. */
  now?: () => number;
}

// A TLS-terminating proxy sees credentials the client never intended to share
// with a logger. Keep them masked by default; the demo opts in explicitly.
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

export function recordableHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  logSecrets: boolean,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (!logSecrets && SECRET_HEADERS.has(lower)) {
      result[name] = '[REDACTED]';
    } else {
      result[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}

export interface FrameRecorder {
  /** Fires when the upstream response headers arrive. */
  onUpstreamResponse: (upstreamRes: IncomingMessage) => void;
  /** Publishes exactly one frame record; call once with the final status. */
  finish: (status: number) => void;
}

/**
 * Times one proxied request and publishes exactly one frame record (A2).
 *
 * The two latency components are merged into a single end-to-end duration as
 * observed by the proxy: request reception + upstream wait + response flush.
 * The record's hop is `client→proxy` because it describes the full round trip
 * on the client-facing leg; the slow-endpoint signal is carried by the gap
 * between `durationMs` (end-to-end) and `internalMs` (proxy work only).
 *
 * Per A2, `internalMs` measures the proxy's own work only — request reception
 * and final response flushing — and explicitly excludes the upstream wait, so
 * `durationMs - internalMs` is the network contribution.
 */
export function createFrameRecorder(
  req: IncomingMessage,
  options: FrameRecorderOptions,
): FrameRecorder {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let requestEndAt: number | null = null;
  let upstreamBodyDoneAt: number | null = null;
  let requestBytes = 0;
  let responseBytes = 0;
  let published = false;

  req.on('data', (chunk: Buffer) => {
    requestBytes += chunk.length;
  });
  req.on('end', () => {
    requestEndAt = now();
  });

  return {
    onUpstreamResponse: (upstreamRes: IncomingMessage) => {
      upstreamRes.on('data', (chunk: Buffer) => {
        responseBytes += chunk.length;
      });
      upstreamRes.on('end', () => {
        upstreamBodyDoneAt = now();
      });
    },

    finish: (status: number) => {
      if (published) return;
      published = true;

      const responseDone = now();
      const requestEnd = requestEndAt ?? responseDone;

      // Waiting on the upstream is network time, not proxy work. Without an
      // upstream response (e.g. a connection error) everything after request
      // reception is attributed to that wait rather than to the proxy.
      const upstreamWait = upstreamBodyDoneAt === null
        ? Math.max(0, responseDone - requestEnd)
        : Math.max(0, upstreamBodyDoneAt - requestEnd);

      const durationMs = Math.max(0, responseDone - startedAt);
      const internalMs = Math.max(0, durationMs - upstreamWait);

      options.bus.publishFrame({
        traceId: options.traceId,
        hop: 'client→proxy',
        method: options.method,
        path: options.path,
        status,
        requestBytes,
        responseBytes,
        durationMs,
        internalMs,
        timestamp: Date.now(),
        group: options.group,
        upstream: options.upstream,
        ...(options.tlsMode === undefined ? {} : {
          tlsMode: options.tlsMode,
          ...(options.sni === undefined ? {} : { sni: options.sni }),
          ...(options.headers === undefined
            ? {}
            : { headers: recordableHeaders(options.headers, options.logSecrets === true) }),
        }),
      });
    },
  };
}
