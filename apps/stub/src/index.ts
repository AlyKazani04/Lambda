import { hostname } from 'node:os';
import { createServer } from 'node:http';

import { apply, servedCount } from './behaviours.js';
import {
  defaultBehaviourFor,
  isBehaviour,
  OVERRIDE_PARAM,
} from './scenarios.js';

// Engineered network phenomena live in behaviours.ts / scenarios.ts (F3).
const port = Number(process.env.STUB_PORT ?? 3001);

// Identity for A1's round-robin verification. Several instances run under one
// Compose service name, so the proxy's "which upstream served this?" log line
// is only useful if each instance can name itself. Compose gives every replica
// of a scaled service a unique hostname, which is exactly what is needed here —
// an env var would be identical across all N replicas. STUB_INSTANCE_ID still
// wins when set, for single-instance local runs.
const instanceId =
  process.env.STUB_INSTANCE_ID || hostname() || 'stub-1';

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', pid: process.pid, instance: instanceId }),
    );
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Per-request override beats the path default, so the load generator can
  // drive a weighted distribution of scenarios (F4).
  const override = url.searchParams.get(OVERRIDE_PARAM);
  if (override !== null && !isBehaviour(override)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown_behaviour', behaviour: override }));
    return;
  }

  const behaviour =
    override !== null && isBehaviour(override)
      ? override
      : defaultBehaviourFor(url.pathname);

  // Deliberate: the behaviour is the thing under test, so it is logged rather
  // than hidden behind a debug flag.
  console.log(
    `instance=${instanceId} ${req.method} ${url.pathname} behaviour=${behaviour} served=${servedCount()}`,
  );

  apply(behaviour, res, url.pathname, url.searchParams);

  // Do not let a client disconnect take the process down: /api/reset is
  // exercised constantly and an unhandled stream error would kill the service.
  res.on('error', () => {
    /* client hung up; expected on reset and close paths */
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`stub listening on 0.0.0.0:${port} instance=${instanceId}`);
});
