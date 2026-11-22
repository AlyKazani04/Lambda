// Unit tests for defensive parsing of WebSocket payloads. A proxy running a
// different version must degrade to a skipped row, never a runtime crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrameEvent, parseRttEvent, parseTcpEvent } from './stream.js';

const frame = {
  traceId: 'abc',
  hop: 'client→proxy',
  method: 'GET',
  path: '/',
  status: 200,
  requestBytes: 12,
  responseBytes: 34,
  durationMs: 1.5,
  internalMs: 0.4,
  timestamp: 1_700_000_000_000,
};

const tcp = {
  timestamp: 1_700_000_000_000,
  src: '192.168.1.10',
  dst: '192.168.1.20',
  srcPort: 51_000,
  dstPort: 8080,
  flags: 'SYN',
  seq: 100,
  ack: 0,
  window: 64_240,
};

test('accepts well-formed frames and TCP events', () => {
  assert.deepEqual(parseFrameEvent(frame), { ...frame, group: undefined, upstream: undefined });
  assert.deepEqual(parseTcpEvent(tcp), { ...tcp, options: undefined });
});

test('rejects null, primitives and malformed shapes without throwing', () => {
  assert.equal(parseFrameEvent(null), null);
  assert.equal(parseTcpEvent('SYN'), null);
  assert.equal(parseFrameEvent({ ...frame, durationMs: undefined }), null);
  assert.equal(parseFrameEvent({ ...frame, traceId: 42 }), null);
  assert.equal(parseTcpEvent({ ...tcp, window: 'large' }), null);
  assert.equal(parseTcpEvent({ ...tcp, src: null }), null);
});

const rtt = {
  kind: 'sample',
  connectionId: '10.0.0.1:51000|10.0.0.2:8080',
  client: '10.0.0.1:51000',
  server: '10.0.0.2:8080',
  timestamp: 1_700_000_000_000,
  sample: { timestamp: 1_700_000_000_000, rttMs: 20, method: 'timestamp', from: '10.0.0.1:51000' },
  srttMs: 20,
  rttvarMs: 10,
  baseRtoMs: 60,
  rtoMs: 1_000,
  backedOff: false,
};

test('accepts well-formed RTT events and rejects malformed ones', () => {
  assert.deepEqual(parseRttEvent(rtt), rtt);
  assert.equal(parseRttEvent(null), null);
  assert.equal(parseRttEvent({ ...rtt, rtoMs: undefined }), null);
  assert.equal(parseRttEvent({ ...rtt, kind: 'bogus' }), null);
  assert.deepEqual(parseRttEvent({ ...rtt, srttMs: null, rttvarMs: null, baseRtoMs: null }), {
    ...rtt,
    srttMs: null,
    rttvarMs: null,
    baseRtoMs: null,
  });
});
