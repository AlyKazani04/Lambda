// Unit tests for defensive parsing of WebSocket payloads. A proxy running a
// different version must degrade to a skipped row, never a runtime crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFrameEvent, parseTcpEvent } from './stream.js';

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
