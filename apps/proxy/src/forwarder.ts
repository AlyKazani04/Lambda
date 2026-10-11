// Request/response forwarding (F2 / A1).
//
// Node's http module gives us the request as a readable stream and the
// response as a writable one, so the body is piped rather than handled chunk
// by chunk. Headers are NOT part of the stream: they are read, filtered and
// written explicitly.

import { request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

import type { UpstreamInstance } from './upstream.js';

/**
 * Headers that describe the *current* connection rather than the message.
 * Forwarding them corrupts the next hop, and the failure only shows up under
 * keep-alive — the worst time to discover it. RFC 9110 §7.6.1.
 */
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

/**
 * Drop hop-by-hop headers.
 *
 * Also drops any header the `Connection` header *names*: those are hop-by-hop
 * by declaration, so removing only the fixed set above still forwards headers
 * the sender marked as belonging to this connection alone.
 */
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

/**
 * Forward `req` to `instance` and pipe the upstream response back.
 *
 * `onSettled` fires once with the status written to the client (or 502 when
 * the upstream could not be reached), so the caller can log the outcome
 * without this module knowing anything about logging.
 */
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
    // req.url is the origin-form target: path *and* query string, verbatim.
    // Rebuilding it from parsed parts is where query strings get lost.
    path: req.url,
    headers: stripHopByHop(req.headers),
  });

  // A client that goes away mid-request must take the upstream request with
  // it, or the socket stays open until the file-descriptor limit is reached.
  // `res` emits 'close' both when we finish it and when the peer vanishes;
  // writableFinished is what tells the two apart.
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  upstreamReq.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode ?? 502;

    // Status code is passed explicitly — it does not default to 200 the way
    // piping makes it look. writeHead must also precede any body write.
    //
    // Upstream headers are echoed here (minus hop-by-hop). That is safe only
    // because v1 never alters the body, so the upstream's Content-Length and
    // framing still describe what we send. A6 (caching) and A8 (TLS
    // termination) rewrite bodies, and at that point Content-Length and
    // Transfer-Encoding must be recomputed rather than forwarded.
    res.writeHead(status, upstreamRes.statusMessage, stripHopByHop(upstreamRes.headers));

    // A truncated upstream response — the stub's /api/reset, or any upstream
    // that dies mid-body — must not become a response that never ends. Node
    // reports the truncation as `complete === false` on close, and as an error
    // on the response or the request depending on how the socket died; all
    // three paths destroy the client socket so the client sees the same broken
    // connection instead of a hang.
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
    res.on('error', () => {
      /* client hung up mid-response; the upstream teardown above handles it */
    });
  });

  upstreamReq.on('error', (error: Error) => {
    if (res.destroyed || res.writableEnded) {
      // The client is already gone — this is the abort path, where we tore the
      // upstream request down ourselves. There is nobody to answer, so writing
      // a status would be a lie in the log and a no-op on the wire. 499 is
      // nginx's "client closed request"; it keeps the outcome line readable
      // instead of reporting a 502 that never reached anyone.
      settled(499);
      return;
    }

    if (res.headersSent) {
      // Headers are already on the wire, so there is no clean way to report
      // this. Destroying the socket is honest: a truncated body tells the
      // client the response is not complete.
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

  // Client aborts mid-body surface here rather than on `res`.
  req.on('error', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}
