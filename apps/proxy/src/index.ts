import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadConfig } from './config.js';
import { forward } from './forwarder.js';
import { matchRoute, pathnameOf } from './router.js';
import { createPools, startDiscovery } from './upstream.js';

const config = loadConfig();

const pools = await createPools(config);
const discovery = startDiscovery(config, pools);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

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
    sendJson(res, 404, { error: 'not_found', path: pathname });
    return;
  }

  const pool = pools.get(route.group);
  if (pool === undefined) {
    sendJson(res, 500, { error: 'no_upstream_group', group: route.group });
    return;
  }

  if (pool.empty) {
    sendJson(res, 503, { error: 'no_upstreams', group: route.group });
    return;
  }

  const instance = pool.next();

  console.log(
    `upstream=${instance.id} group=${route.group} ${req.method} ${req.url}`,
  );

  forward(req, res, instance, ({ status }) => {
    console.log(`upstream=${instance.id} status=${status} ${req.method} ${req.url}`);
  });
}

const server = createServer(handleRequest);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    discovery.stop();
    server.close(() => process.exit(0));
  });
}

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
