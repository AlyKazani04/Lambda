// Request/response forwarding (F2 / A1).

import { request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

import type { UpstreamInstance } from './upstream.js';
import {
  clientWantsClose,
  responseWantsClose,
  stripBodylessHeaders,
} from './l7/http-parse.js';

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

export interface ForwardOptions {
  /** Trace ID propagated upstream and echoed back on the response. */
  traceId?: string;
  /** Fires once with the status written to the client. */
  onSettled?: (outcome: ForwardOutcome) => void;
  /** Fires when the upstream response headers arrive. */
  onUpstreamResponse?: (upstreamRes: IncomingMessage) => void;
  /** Fires when the upstream sends 100 Continue, so it can be relayed. */
  onUpstreamContinue?: () => void;
}

/**
 * Forward `req` to `instance` and pipe the upstream response back.
 *
 * `onSettled` fires once with the status written to the client, so the caller
 * can log the outcome without this module knowing anything about logging.
 */
export function forward(
  req: IncomingMessage,
  res: ServerResponse,
  instance: UpstreamInstance,
  options?: ForwardOptions,
): void {
  const traceId = options?.traceId;
  const settled = (status: number): void => {
    options?.onSettled?.({ status });
  };

  const closeUpstream = clientWantsClose(req);
  const upstreamHeaders = stripHopByHop(req.headers);
  if (traceId !== undefined) upstreamHeaders['x-request-id'] = traceId;
  // Relay the client's close request upstream so the upstream connection is
  // not kept alive for a client that will not reuse it.
  if (closeUpstream) upstreamHeaders['connection'] = 'close';

  const upstreamReq = httpRequest({
    host: instance.host,
    port: instance.port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders,
  });

  // The upstream's 100 Continue is an interim response on the way to the final
  // one. The caller relays it so the client sends its body.
  upstreamReq.on('continue', () => {
    options?.onUpstreamContinue?.();
  });

  // A client that goes away mid-request must take the upstream request with it,
  // or the socket stays open until the file-descriptor limit is reached. `res`
  // emits 'close' on both finish and abort; writableFinished tells them apart.
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode ?? 502;
    options?.onUpstreamResponse?.(upstreamRes);

    // Framing headers are safe to echo only because v1 never alters the body; A6/A8 rewrite bodies and must recompute them.
    const responseHeaders = stripHopByHop(upstreamRes.headers);
    if (traceId !== undefined) responseHeaders['x-request-id'] = traceId;
    // Trailer is hop-by-hop, so stripHopByHop drops it; re-add it because the
    // proxy re-emits the trailers after the body.
    const trailer = upstreamRes.headers['trailer'];
    if (trailer !== undefined) responseHeaders['trailer'] = trailer;
    const finalHeaders = stripBodylessHeaders(responseHeaders, status, req.method ?? 'GET');
    // An upstream close must reach the client: the proxy cannot reuse the
    // upstream connection, so keeping the client connection open would only
    // invite a request onto a socket the upstream has discarded.
    if (closeUpstream || responseWantsClose(upstreamRes.headers)) {
      finalHeaders['connection'] = 'close';
    }
    res.writeHead(status, upstreamRes.statusMessage, finalHeaders);

    // Node's client exposes trailers on `res.trailers` once the body is read
    // rather than emitting a 'trailers' event, so re-emit them before the pipe
    // ends the response.
    upstreamRes.on('end', () => {
      const trailers = upstreamRes.trailers;
      if (trailers !== undefined && Object.keys(trailers).length > 0 && !res.writableEnded) {
        res.addTrailers({ ...trailers });
      }
    });

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
    const errorHeaders: OutgoingHttpHeaders = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (traceId !== undefined) errorHeaders['x-request-id'] = traceId;
    res.writeHead(502, errorHeaders);
    res.end(body);
    settled(502);
  });

  req.on('error', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}
