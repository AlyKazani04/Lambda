// Unit tests for defensive parsing of WebSocket payloads. A proxy running a
// different version must degrade to a skipped row, never a runtime crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrameEvent, parseRetransmitEvent, parseRttEvent, parseSlowlorisEvent, parseTcpEvent } from './stream.js';

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

const retransmit = {
  kind: 'partial',
  cause: 'fast',
  connectionId: '10.0.0.1:51000|10.0.0.2:8080',
  client: '10.0.0.1:51000',
  server: '10.0.0.2:8080',
  from: '10.0.0.1:51000',
  timestamp: 1_700_000_000_000,
  seq: 1_100,
  length: 100,
  overlapBytes: 50,
  delayMs: 13,
  observedRtoMs: null,
  dupAcks: 3,
  rate: 0.1,
  globalRate: 0.05,
  truncated: false,
};

test('accepts well-formed retransmit events and rejects malformed ones', () => {
  assert.deepEqual(parseRetransmitEvent(retransmit), retransmit);
  assert.equal(parseRetransmitEvent(null), null);
  assert.equal(parseRetransmitEvent({ ...retransmit, observedRtoMs: undefined }), null);
  assert.equal(parseRetransmitEvent({ ...retransmit, cause: 'weird' }), null);
  const timeout = { ...retransmit, kind: 'full', cause: 'timeout', observedRtoMs: 240 };
  assert.deepEqual(parseRetransmitEvent(timeout), timeout);
});

const slowloris = {
  phase: 'headers',
  reason: 'headers_idle',
  client: '127.0.0.1:4321',
  elapsedMs: 15_000,
  bytesReceived: 12,
  timestamp: 1_700_000_000_000,
};

test('accepts slowloris events and rejects an unknown phase', () => {
  assert.deepEqual(parseSlowlorisEvent(slowloris), {
    ...slowloris,
    traceId: undefined,
    path: undefined,
  });
  assert.deepEqual(parseSlowlorisEvent({ ...slowloris, traceId: 'trace-1', path: '/api/slow' }), {
    ...slowloris,
    traceId: 'trace-1',
    path: '/api/slow',
  });
  assert.equal(parseSlowlorisEvent({ ...slowloris, phase: 'bogus' }), null);
  assert.equal(parseSlowlorisEvent({ ...slowloris, elapsedMs: '15' }), null);
});
