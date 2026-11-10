import { performance } from 'node:perf_hooks';
import type { IncomingMessage } from 'node:http';

import type { FrameBus } from '../bus/redis.js';

export interface FrameRecorderOptions {
  bus: FrameBus;
  traceId: string;
  method: string;
  path: string;
  group: string;
  upstream: string;
}

export interface FrameRecorder {
  /** Fires when the upstream response headers arrive. */
  onUpstreamResponse: (upstreamRes: IncomingMessage) => void;
  /** Publishes both hop records; call once with the final status. */
  finish: (status: number) => void;
}

/**
 * Times one proxied request and publishes a record per hop.
 *
 * The proxy cannot see when the client sent the request, so the client→proxy
 * duration is the proxy's own request-leg time, while the proxy→upstream
 * duration spans the upstream wait. The two records share a trace ID so the
 * dashboard can show the two latency clusters separately.
 */
export function createFrameRecorder(
  req: IncomingMessage,
  options: FrameRecorderOptions,
): FrameRecorder {
  const startedAt = performance.now();
  let requestEnd = startedAt;
  let upstreamBodyDone = startedAt;
  let requestBytes = 0;
  let responseBytes = 0;
  let published = false;

  req.on('data', (chunk: Buffer) => {
    requestBytes += chunk.length;
  });
  req.on('end', () => {
    requestEnd = performance.now();
  });

  return {
    onUpstreamResponse: (upstreamRes: IncomingMessage) => {
      upstreamRes.on('data', (chunk: Buffer) => {
        responseBytes += chunk.length;
      });
      upstreamRes.on('end', () => {
        upstreamBodyDone = performance.now();
      });
    },

    finish: (status: number) => {
      if (published) return;
      published = true;

      const responseDone = performance.now();
      const timestamp = Date.now();
      const base = {
        traceId: options.traceId,
        method: options.method,
        path: options.path,
        status,
        requestBytes,
        responseBytes,
        timestamp,
        group: options.group,
        upstream: options.upstream,
      };

      options.bus.publishFrame({
        ...base,
        hop: 'client→proxy',
        durationMs: requestEnd - startedAt,
        internalMs: requestEnd - startedAt,
      });
      options.bus.publishFrame({
        ...base,
        hop: 'proxy→upstream',
        durationMs: responseDone - requestEnd,
        internalMs: responseDone - upstreamBodyDone,
      });
    },
  };
}
