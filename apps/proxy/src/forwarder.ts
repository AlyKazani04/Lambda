// Request/response forwarding (F2 / A1).

import { request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

import type { UpstreamInstance } from './upstream.js';

// Hop-by-hop headers (RFC 9110 §7.6.1) — describe the current connection, not
// the message. Forwarding them corrupts the next hop under keep-alive.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Drop hop-by-hop headers, plus any header the Connection header names.
export function stripHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const declaredHopByHop = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );

  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || declaredHopByHop.has(lower)) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

export interface ForwardOutcome {
  status: number;
}

export function forward(
  req: IncomingMessage,
  res: ServerResponse,
  instance: UpstreamInstance,
  onSettled?: (outcome: ForwardOutcome) => void,
): void {
  const settled = (status: number): void => {
    onSettled?.({ status });
  };

  const upstreamReq = httpRequest({
    host: instance.host,
    port: instance.port,
    method: req.method,
    path: req.url,
    headers: stripHopByHop(req.headers),
  });

  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode ?? 502;

    // Framing headers are safe to echo only because v1 never alters the body; A6/A8 rewrite bodies and must recompute them.
    res.writeHead(status, upstreamRes.statusMessage, stripHopByHop(upstreamRes.headers));

    // A truncated upstream (the stub's /api/reset) must not become a response that never ends; destroy the client socket.
    upstreamRes.on('close', () => {
      if (!upstreamRes.complete) res.destroy();
    });
    upstreamRes.on('error', () => {
      res.destroy();
    });

    upstreamRes.pipe(res);
    res.on('finish', () => {
      settled(status);
    });
    // Client hung up mid-response; the upstream teardown above handles it.
    res.on('error', () => {});
  });

  upstreamReq.on('error', (error: Error) => {
    if (res.destroyed || res.writableEnded) {
      settled(499);
      return;
    }

    if (res.headersSent) {
      res.destroy();
      settled(res.statusCode);
      return;
    }

    const body = JSON.stringify({
      error: 'bad_gateway',
      upstream: instance.id,
      message: error.message,
    });
    res.writeHead(502, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    settled(502);
  });

  req.on('error', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}
