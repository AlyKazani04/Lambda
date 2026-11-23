import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket, RetransmitEvent } from 'shared-types';

import { parsePacket } from './packet-parser.js';
import { RetransmitAnalyser } from './retransmit.js';

const CLIENT = { ip: '10.0.0.1', port: 51_000 };
const SERVER = { ip: '10.0.0.2', port: 8080 };

const DATA = 0x18;
const ACK = 0x10;

function pkt(spec: {
  from: 'client' | 'server';
  srcPort?: number;
  seq: number;
  ack?: number;
  flags?: number;
  timestamp: number;
  payloadLength?: number;
  originalLength?: number;
}): ParsedPacket {
  const base = spec.from === 'client' ? CLIENT : SERVER;
  const dst = spec.from === 'client' ? SERVER : CLIENT;
  const src = { ip: base.ip, port: spec.srcPort ?? base.port };
  const payload = Buffer.alloc(spec.payloadLength ?? 0);
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(src.port, 0);
  tcp.writeUInt16BE(dst.port, 2);
  tcp.writeUInt32BE(spec.seq >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt8(0x50, 12);
  tcp.writeUInt8(spec.flags ?? DATA, 13);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(40 + payload.length, 2);
  ip.writeUInt8(6, 9);
  for (let i = 0; i < 4; i += 1) {
    ip.writeUInt8(Number(src.ip.split('.')[i]), 12 + i);
    ip.writeUInt8(Number(dst.ip.split('.')[i]), 16 + i);
  }
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);

  const bytes = Buffer.concat([eth, ip, tcp, payload]);
  const parsed = parsePacket({
    bytes,
    timestamp: spec.timestamp,
    capturedLength: bytes.length,
    originalLength: spec.originalLength ?? bytes.length,
    linkType: 1,
  });
  assert.notEqual(parsed, null);
  return parsed!;
}

test('a repeated data range is reported as a full retransmission', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_020 }));

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.kind, 'full');
  assert.equal(event.seq, 1_000);
  assert.equal(event.length, 100);
  assert.equal(event.overlapBytes, 100);
  assert.equal(event.delayMs, 20);
  assert.equal(event.cause, 'timeout');
  assert.equal(event.dupAcks, 0);
  assert.equal(event.timestamp, 1_020);
  assert.equal(event.from, '10.0.0.1:51000');
  assert.equal(event.connectionId, '10.0.0.1:51000|10.0.0.2:8080');
  assert.equal(event.rate, 0.5);
  assert.equal(event.globalRate, 0.5);
});

test('timeout retransmissions expose the observed RTO, fast ones do not', () => {
  const timeout: RetransmitEvent[] = [];
  const timeoutAnalyser = new RetransmitAnalyser({ publish: (event) => timeout.push(event) });
  timeoutAnalyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  timeoutAnalyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_300 }));

  assert.equal(timeout[0]?.cause, 'timeout');
  assert.equal(timeout[0]?.observedRtoMs, 300);

  const fast: RetransmitEvent[] = [];
  const fastAnalyser = new RetransmitAnalyser({ publish: (event) => fast.push(event) });
  fastAnalyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  fastAnalyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: 1_010 }));
  fastAnalyser.observe(pkt({ from: 'client', seq: 1_100, payloadLength: 100, timestamp: 1_012 }));
  for (const at of [1_014, 1_016, 1_018]) {
    fastAnalyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: at }));
  }
  fastAnalyser.observe(pkt({ from: 'client', seq: 1_100, payloadLength: 100, timestamp: 1_025 }));

  assert.equal(fast[0]?.cause, 'fast');
  assert.equal(fast[0]?.observedRtoMs, null);
});

test('three duplicate ACKs mark the following retransmission as fast', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: 1_010 }));
  analyser.observe(pkt({ from: 'client', seq: 1_100, payloadLength: 100, timestamp: 1_012 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: 1_014 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: 1_016 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: ACK, timestamp: 1_018 }));
  analyser.observe(pkt({ from: 'client', seq: 1_100, payloadLength: 100, timestamp: 1_025 }));

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.cause, 'fast');
  assert.equal(event.dupAcks, 3);
  assert.equal(event.delayMs, 13);
});

test('a shorter overlapping range is a partial retransmission', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'client', seq: 1_050, payloadLength: 100, timestamp: 1_030 }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'partial');
  assert.equal(events[0]?.overlapBytes, 50);
  assert.equal(events[0]?.delayMs, 30);
});

test('sequence range overlap survives the 32-bit wrap boundary', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 0xffff_ff00, payloadLength: 256, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'client', seq: 0xffff_ffc0, payloadLength: 64, timestamp: 1_020 }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'partial');
  assert.equal(events[0]?.overlapBytes, 64);
});

test('a late non-overlapping segment is reordering, not a retransmission', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_100, payloadLength: 100, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_010 }));

  assert.equal(events.length, 0);
  assert.equal(analyser.snapshot().segments, 2);
});

test('a truncated capture is flagged instead of trusted for length comparison', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000, originalLength: 200 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_020, originalLength: 200 }));

  assert.equal(events[0]?.truncated, true);
});

test('range history and retained events are bounded and idle connections expire', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({
    maxRanges: 2,
    maxEvents: 2,
    staleAfterMs: 500,
    publish: (event) => events.push(event),
  });

  for (let i = 0; i < 5; i += 1) {
    analyser.observe(pkt({ from: 'client', seq: 1_000 + i * 100, payloadLength: 100, timestamp: 1_000 + i }));
  }
  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_100 }));
  assert.equal(events.length, 0);

  analyser.observe(pkt({ from: 'client', seq: 1_400, payloadLength: 100, timestamp: 1_110 }));
  analyser.observe(pkt({ from: 'client', seq: 1_400, payloadLength: 100, timestamp: 1_120 }));
  assert.equal(events.length, 2);

  assert.equal(analyser.sweep(2_000), 1);
  assert.equal(analyser.size, 0);
});

test('the global rate includes segments from every connection', () => {
  const events: RetransmitEvent[] = [];
  const analyser = new RetransmitAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_000 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, payloadLength: 100, timestamp: 1_020 }));
  analyser.observe(pkt({ from: 'client', seq: 2_000, payloadLength: 100, timestamp: 1_000, srcPort: 52_000 }));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.rate, 0.5);
  assert.equal(events[0]?.globalRate, 0.5);
  assert.ok(Math.abs(analyser.snapshot().globalRate - 1 / 3) < 1e-9);
});
