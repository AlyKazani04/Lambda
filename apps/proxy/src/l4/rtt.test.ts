import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket } from 'shared-types';

import { parsePacket } from './packet-parser.js';
import { RttAnalyser, RttEstimator, type RttEstimateEvent } from './rtt.js';

const CLIENT = { ip: '10.0.0.1', port: 51_000 };
const SERVER = { ip: '10.0.0.2', port: 8080 };

function pkt(spec: {
  from: 'client' | 'server';
  seq: number;
  ack?: number;
  flags?: number;
  timestamp: number;
  payloadLength?: number;
  tsVal?: number;
  tsEcr?: number;
}): ParsedPacket {
  const src = spec.from === 'client' ? CLIENT : SERVER;
  const dst = spec.from === 'client' ? SERVER : CLIENT;
  const hasTimestamps = spec.tsVal !== undefined || spec.tsEcr !== undefined;
  const tcpHeaderLen = hasTimestamps ? 32 : 20;
  const payload = Buffer.alloc(spec.payloadLength ?? 0);
  const tcp = Buffer.alloc(tcpHeaderLen);
  tcp.writeUInt16BE(src.port, 0);
  tcp.writeUInt16BE(dst.port, 2);
  tcp.writeUInt32BE(spec.seq >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt8((tcpHeaderLen / 4) << 4, 12);
  tcp.writeUInt8(spec.flags ?? 0x18, 13);
  if (hasTimestamps) {
    tcp.writeUInt8(1, 20);
    tcp.writeUInt8(1, 21);
    tcp.writeUInt8(8, 22);
    tcp.writeUInt8(10, 23);
    tcp.writeUInt32BE((spec.tsVal ?? 0) >>> 0, 24);
    tcp.writeUInt32BE((spec.tsEcr ?? 0) >>> 0, 28);
  }

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(20 + tcpHeaderLen + payload.length, 2);
  ip.writeUInt8(6, 9);
  for (let i = 0; i < 4; i += 1) {
    ip.writeUInt8(Number(src.ip.split('.')[i]), 12 + i);
    ip.writeUInt8(Number(dst.ip.split('.')[i]), 16 + i);
  }
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);

  const parsed = parsePacket({
    bytes: Buffer.concat([eth, ip, tcp, payload]),
    timestamp: spec.timestamp,
    capturedLength: 14 + 20 + tcpHeaderLen + payload.length,
    originalLength: 14 + 20 + tcpHeaderLen + payload.length,
    linkType: 1,
  });
  assert.notEqual(parsed, null);
  return parsed!;
}

test('a timestamp echo produces an RTT sample from capture times', () => {
  const events: RttEstimateEvent[] = [];
  const analyser = new RttAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, timestamp: 10_000, payloadLength: 100, tsVal: 5_000 }));
  analyser.observe(pkt({ from: 'server', seq: 7_000, ack: 1_100, flags: 0x10, timestamp: 10_020, tsEcr: 5_000 }));

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.kind, 'sample');
  assert.deepEqual(event.sample, {
    timestamp: 10_020,
    rttMs: 20,
    method: 'timestamp',
    from: '10.0.0.1:51000',
  });
  assert.equal(event.srttMs, 20);
  assert.equal(event.rttvarMs, 10);
  assert.equal(event.rtoMs, 1_000);
});

test('acknowledgement matching supplies RTT when timestamps are absent', () => {
  const events: RttEstimateEvent[] = [];
  const analyser = new RttAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 2_000, timestamp: 1_000, payloadLength: 50 }));
  analyser.observe(pkt({ from: 'server', seq: 9_000, ack: 2_050, flags: 0x10, timestamp: 1_015 }));

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.sample?.method, 'seq-ack');
  assert.equal(event.sample?.rttMs, 15);
  assert.equal(event.srttMs, 15);
});

test('a retransmitted data segment backs off the timer without changing SRTT', () => {
  const events: RttEstimateEvent[] = [];
  const analyser = new RttAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, timestamp: 0, payloadLength: 100, tsVal: 100 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: 0x10, timestamp: 40, tsEcr: 100 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, timestamp: 100, payloadLength: 100, tsVal: 100 }));

  const backoff = events.at(-1)!;
  assert.equal(events.length, 2);
  assert.equal(backoff.kind, 'backoff');
  assert.equal(backoff.rtoMs, 2_000);
  assert.equal(backoff.baseRtoMs, 120);
  assert.equal(backoff.srttMs, 40);
  assert.equal(backoff.backedOff, true);
});

test('a pure acknowledgement restores the timer after backoff', () => {
  const events: RttEstimateEvent[] = [];
  const analyser = new RttAnalyser({ publish: (event) => events.push(event) });

  analyser.observe(pkt({ from: 'client', seq: 1_000, timestamp: 0, payloadLength: 100, tsVal: 100 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 1_100, flags: 0x10, timestamp: 40, tsEcr: 100 }));
  analyser.observe(pkt({ from: 'client', seq: 1_000, timestamp: 100, payloadLength: 100, tsVal: 100 }));
  analyser.observe(pkt({ from: 'server', seq: 5_000, ack: 4_000, flags: 0x10, timestamp: 140 }));

  const restored = events.at(-1)!;
  assert.equal(restored.kind, 'ack');
  assert.equal(restored.rtoMs, 1_000);
  assert.equal(restored.baseRtoMs, 120);
  assert.equal(restored.backedOff, false);
});

test('first sample initializes SRTT to the sample and RTTVAR to half of it', () => {
  const estimator = new RttEstimator();

  const state = estimator.observe(400);

  assert.equal(state.srttMs, 400);
  assert.equal(state.rttvarMs, 200);
  assert.equal(state.baseRtoMs, 1200);
  assert.equal(state.rtoMs, 1200);
});

test('subsequent samples smooth SRTT at 1/8 and RTTVAR at 1/4', () => {
  const estimator = new RttEstimator();
  estimator.observe(400);

  const second = estimator.observe(800);

  assert.equal(second.rttvarMs, 250);
  assert.equal(second.srttMs, 450);
  assert.equal(second.baseRtoMs, 1450);

  const third = estimator.observe(200);

  assert.equal(third.rttvarMs, 250);
  assert.equal(third.srttMs, 418.75);
  assert.equal(third.baseRtoMs, 1418.75);
});

test('backoff doubles the timer and an acknowledgement restores the computed RTO', () => {
  const estimator = new RttEstimator();
  estimator.observe(400);

  estimator.retransmit();
  const backedOff = estimator.snapshot();
  assert.equal(backedOff.rtoMs, 2_400);
  assert.equal(backedOff.baseRtoMs, 1_200);
  assert.equal(backedOff.srttMs, 400);
  assert.equal(backedOff.backedOff, true);

  estimator.acknowledged();
  const restored = estimator.snapshot();
  assert.equal(restored.rtoMs, 1_200);
  assert.equal(restored.backedOff, false);
});

test('RTO stays inside one to sixty seconds, including after backoff', () => {
  const small = new RttEstimator().observe(20);
  assert.equal(small.rtoMs, 1_000);
  assert.equal(small.baseRtoMs, 60);

  const large = new RttEstimator();
  large.observe(40_000);
  large.retransmit();
  assert.equal(large.snapshot().rtoMs, 60_000);
});

test('pending samples are capped and idle connections expire', () => {
  const events: RttEstimateEvent[] = [];
  const analyser = new RttAnalyser({
    maxPending: 2,
    staleAfterMs: 500,
    publish: (event) => events.push(event),
  });

  for (let i = 0; i < 5; i += 1) {
    analyser.observe(pkt({ from: 'client', seq: 1_000 + i * 10, timestamp: 100 + i, payloadLength: 10 }));
  }
  analyser.observe(pkt({ from: 'server', seq: 9_000, ack: 1_030, flags: 0x10, timestamp: 200 }));

  assert.equal(analyser.pendingCount, 2);
  assert.equal(events.length, 0);

  analyser.observe(pkt({ from: 'server', seq: 9_000, ack: 1_050, flags: 0x10, timestamp: 210 }));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.sample?.rttMs, 106);

  assert.equal(analyser.sweep(1_000), 1);
  assert.equal(analyser.size, 0);
});
