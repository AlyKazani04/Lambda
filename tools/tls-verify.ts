// A8 wire-level verification: real TLS handshakes through the gateway.
//
// Run with TLS_VERIFY_CERT_DIR pointing at a directory containing
// secure.example.pem/-key.pem and tunnel.example.pem/-key.pem (see
// tools/generate-certs.sh). This script starts a plaintext upstream and a TLS
// origin, exercises both gateway routes, and asserts what reached the bus.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';

import type { FrameBus } from '../apps/proxy/src/bus/redis.js';
import { loadConfig } from '../apps/proxy/src/config.js';
import { createFrameRecorder } from '../apps/proxy/src/l7/frame-logger.js';
import { createTlsGateway } from '../apps/proxy/src/l7/gateway.js';
import type { FrameEvent, SniRouteEvent } from 'shared-types';

class RecordingBus implements FrameBus {
  readonly frames: FrameEvent[] = [];
  readonly routes: SniRouteEvent[] = [];
  publishFrame(frame: FrameEvent): void { this.frames.push(frame); }
  publishSniRoute(route: SniRouteEvent): void { this.routes.push(route); }
  publishTcp(): void {}
  publishTcpState(): void {}
  publishRtt(): void {}
  publishRetransmit(): void {}
  publishSlowloris(): void {}
  ready(): Promise<void> { return Promise.resolve(); }
  async close(): Promise<void> {}
}

function get(url: string, ca: Buffer[], headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    // Connect by IP but keep the hostname as SNI: the demo hostnames have no
    // DNS entry and the gateway routes on SNI, not on the socket destination.
    const req = httpsRequest({
      hostname: '127.0.0.1',
      port: Number(target.port),
      path: target.pathname,
      servername: target.hostname,
      ca,
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const certDir = process.env.TLS_VERIFY_CERT_DIR
  ?? fileURLToPath(new URL('../certs/', import.meta.url));
const read = (name: string): Buffer => readFileSync(`${certDir}/${name}`);
const secureCert = read('secure.example.pem');
const tunnelCert = read('tunnel.example.pem');
const tunnelKey = read('tunnel.example-key.pem');

const UPSTREAM_PORT = 28_001;
const ORIGIN_PORT = 28_444;
const TLS_PORT = 28_443;

const upstream = createHttpServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
});
const origin = createHttpsServer({ cert: tunnelCert, key: tunnelKey }, (_req, res) => {
  res.end('PASSTHROUGH-OK');
});

await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
await new Promise<void>((resolve) => origin.listen(ORIGIN_PORT, '127.0.0.1', resolve));

const bus = new RecordingBus();
const config = loadConfig({
  TLS_ENABLED: 'true',
  TLS_PORT: String(TLS_PORT),
  TLS_LOG_SECRETS: 'true',
  TLS_CERT_FILE: `${certDir}/secure.example.pem`,
  TLS_KEY_FILE: `${certDir}/secure.example-key.pem`,
  TLS_SNI_ROUTES: JSON.stringify([
    { host: 'secure.example', mode: 'decrypt', group: 'api' },
    { host: 'tunnel.example', mode: 'passthrough', target: `127.0.0.1:${ORIGIN_PORT}` },
  ]),
  SLOWLORIS_ENABLED: 'false',
});

const gateway = createTlsGateway({
  config,
  bus,
  onDecryptedRequest: (req, res, context) => {
    const recorder = createFrameRecorder(req, {
      bus,
      traceId: 'tls-verify',
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      group: context.group,
      upstream: `127.0.0.1:${UPSTREAM_PORT}`,
      tlsMode: 'decrypt',
      sni: context.sni,
      headers: req.headers,
      logSecrets: context.logSecrets,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, sni: context.sni }));
    res.on('finish', () => recorder.finish(200));
  },
});

await gateway.listen();
const ca = [secureCert, tunnelCert];

const decrypted = await get(
  `https://secure.example:${TLS_PORT}/api/timeline`,
  ca,
  { authorization: 'Bearer verify-token' },
);
assert.equal(decrypted.status, 200, 'decrypted route must answer 200');
assert.equal(JSON.parse(decrypted.body).sni, 'secure.example');
assert.equal(bus.frames.length, 1, 'exactly one decrypted frame');
assert.equal(bus.frames[0]?.tlsMode, 'decrypt');
assert.equal(bus.frames[0]?.sni, 'secure.example');
assert.equal(bus.frames[0]?.headers?.['authorization'], 'Bearer verify-token');

const passthrough = await get(`https://tunnel.example:${TLS_PORT}/`, ca);
assert.equal(passthrough.body, 'PASSTHROUGH-OK', 'raw bytes must reach the TLS origin');
assert.equal(bus.frames.length, 1, 'passthrough must not produce a decrypted frame');
// Closing the gateway tears down the raw upstream socket, which is when the
// route event is published.
await gateway.close();
await new Promise((resolve) => setTimeout(resolve, 200));
assert.equal(bus.routes[0]?.host, 'tunnel.example');
assert.equal(bus.routes[0]?.mode, 'passthrough');

await new Promise<void>((resolve) => origin.close(() => resolve()));
await new Promise<void>((resolve) => upstream.close(() => resolve()));
console.log('A8 VERIFIED: decrypt + SNI frame, raw passthrough, no decrypted passthrough frame');
