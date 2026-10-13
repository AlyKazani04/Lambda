import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadConfig } from './config.js';
import { forward } from './forwarder.js';
import { matchRoute, pathnameOf } from './router.js';
import { createPools, startDiscovery } from './upstream.js';

// L7 reverse proxy core (F2 / #7, A1 / #15).
//
// In request order: resolve the path prefix to an upstream group, pick the next
// instance in that group's rotation, forward the request, pipe the response
// back. Frame logging (A2) and capture (B1) sit on top of this and are not here.

const config = loadConfig();

/** Upstream pools, keyed by group. Populated before the listener opens. */
const pools = await createPools(config);

// Keeps the instance lists in step with DNS. See startDiscovery for the
// start-order race this closes.
const discovery = startDiscovery(config, pools);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Health is answered by the proxy itself, never forwarded: it is a liveness
 * probe for *this* process, and routing it upstream would make the proxy's
 * health a statement about the stub's. The container healthcheck and the CI
 * smoke test both depend on it.
 */
function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    pid: process.pid,
    upstreams: [...pools.values()].map((pool) => ({
      group: pool.group,
      instances: pool.stats(),
    })),
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = pathnameOf(req.url);

  if (pathname === '/health' || pathname === '/health/') {
    handleHealth(res);
    return;
  }

  if (pathname === null) {
    sendJson(res, 400, { error: 'bad_request', target: req.url });
    return;
  }

  const route = matchRoute(pathname, config.routes);
  if (route === null) {
    // A clean 404 with a JSON body, not a thrown exception and not a hang.
    sendJson(res, 404, { error: 'not_found', path: pathname });
    return;
  }

  const pool = pools.get(route.group);
  if (pool === undefined) {
    // Unreachable via loadConfig, which builds a pool per group in the table.
    // Kept so a silently undefined pool is a clean 500 rather than a TypeError.
    sendJson(res, 500, { error: 'no_upstream_group', group: route.group });
    return;
  }

  const instance = pool.next();

  // Logged on every request: when round-robin looks broken, this one line is
  // the whole diagnosis, and it is the evidence for A1's rotation criterion.
  console.log(
    `upstream=${instance.id} group=${route.group} ${req.method} ${req.url}`,
  );

  forward(req, res, instance, ({ status }) => {
    console.log(`upstream=${instance.id} status=${status} ${req.method} ${req.url}`);
  });
}

const server = createServer(handleRequest);

// Discovery runs on a timer; stop it explicitly so a SIGTERM leaves nothing behind.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    discovery.stop();
    server.close(() => process.exit(0));
  });
}

// Long-lived connections are the point of a proxy, but an idle client must not
// hold a socket forever. Kept above the stub's longest engineered delay (5000ms)
// so a slow response is never cut off by our own timeout.
server.headersTimeout = 65_000;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

server.listen(config.port, config.host, () => {
  const groups = [...pools.values()]
    .map((pool) => `${pool.group}=[${pool.instances.map((i) => i.id).join(', ')}]`)
    .join(' ');
  console.log(
    `proxy listening on ${config.host}:${config.port} ` +
      `routes=[${config.routes.map((r) => `${r.prefix}->${r.group}`).join(', ')}] ` +
      `upstreams: ${groups}`,
  );
});
