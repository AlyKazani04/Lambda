// Unit tests for the B3 handshake analyser.
//
// These are pure functions over synthetic frames: no capture, no privileges,
// no network. They build real Ethernet/IPv4/TCP bytes and run them through the
// same parsePacket() the proxy uses, so the tests exercise the actual decode
// path rather than a test-only shortcut.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket } from 'shared-types';
import type { HandshakeAggregate, HandshakeOptions, HandshakeResult } from './handshake.js';

import { parsePacket } from './packet-parser.js';
import { createConsoleHandshakePublisher, HandshakeAnalyser } from './handshake.js';

const ETHERTYPE_IPV4 = 0x0800;

const CLIENT = { ip: '192.168.1.10', port: 51_000 };
const SERVER = { ip: '192.168.1.20', port: 8080 };

interface FrameSpec {
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  seq: number;
  ack?: number;
  syn?: boolean;
  ackFlag?: boolean;
  rst?: boolean;
  timestamp: number;
}

interface Endpoint {
  ip: string;
  port: number;
}

function ipToBytes(ip: string): [number, number, number, number] {
  const parts = ip.split('.');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/** Build a minimal but structurally valid Ethernet + IPv4 + TCP frame. */
function buildFrame(spec: FrameSpec): Buffer {
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(spec.srcPort, 0);
  tcp.writeUInt16BE(spec.dstPort, 2);
  tcp.writeUInt32BE(spec.seq >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt16BE(0x5000, 12); // data offset 5 words, reserved bits 0
  tcp.writeUInt8(
    (spec.syn === true ? 0x02 : 0) |
      (spec.ackFlag === true ? 0x10 : 0) |
      (spec.rst === true ? 0x04 : 0),
    13,
  );
  tcp.writeUInt16BE(65_535, 14);
  tcp.writeUInt16BE(0, 16); // checksum: parsePacket does not validate it
  tcp.writeUInt16BE(0, 18);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0); // version 4, IHL 5
  ip.writeUInt16BE(20 + tcp.length, 2);
  ip.writeUInt16BE(0, 4); // identification
  ip.writeUInt16BE(0, 6); // flags + fragment offset
  ip.writeUInt8(64, 8);
  ip.writeUInt8(6, 9); // protocol TCP
  ip.writeUInt16BE(0, 10); // header checksum: not validated
  const src = ipToBytes(spec.srcIp);
  const dst = ipToBytes(spec.dstIp);
  ip.writeUInt8(src[0]!, 12);
  ip.writeUInt8(src[1]!, 13);
  ip.writeUInt8(src[2]!, 14);
  ip.writeUInt8(src[3]!, 15);
  ip.writeUInt8(dst[0]!, 16);
  ip.writeUInt8(dst[1]!, 17);
  ip.writeUInt8(dst[2]!, 18);
  ip.writeUInt8(dst[3]!, 19);

  const ethernet = Buffer.alloc(14);
  ethernet.writeUInt16BE(ETHERTYPE_IPV4, 12);

  return Buffer.concat([ethernet, ip, tcp]);
}

function frame(
  src: Endpoint,
  dst: Endpoint,
  options: {
    seq: number;
    ack?: number;
    syn?: boolean;
    ackFlag?: boolean;
    rst?: boolean;
    timestamp: number;
  },
): FrameSpec {
  return {
    srcIp: src.ip,
    srcPort: src.port,
    dstIp: dst.ip,
    dstPort: dst.port,
    seq: options.seq,
    ack: options.ack,
    syn: options.syn,
    ackFlag: options.ackFlag,
    rst: options.rst,
    timestamp: options.timestamp,
  };
}

function packet(spec: FrameSpec): ParsedPacket {
  const bytes = buildFrame(spec);
  const parsed = parsePacket({
    bytes,
    timestamp: spec.timestamp,
    capturedLength: bytes.length,
    originalLength: bytes.length,
    linkType: 1,
  });
  assert.notEqual(parsed, null, 'fixture must parse');
  return parsed!;
}

function observe(analyser: HandshakeAnalyser, spec: FrameSpec): void {
  analyser.observe(packet(spec));
}

/** Deterministic harness: fake clock, no timer. */
function createHarness(options?: Omit<HandshakeOptions, 'now' | 'sweepIntervalMs'>) {
  let clock = 0;
  const analyser = new HandshakeAnalyser({
    sweepIntervalMs: 0,
    now: () => clock,
    ...options,
  });
  return {
    analyser,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

/** Drive one full handshake with the given step durations. */
function completeConnection(
  analyser: HandshakeAnalyser,
  client: Endpoint,
  server: Endpoint,
  start: number,
  synToSynAck: number,
  synAckToAck: number,
): void {
  const seq = 1_000;
  const synAckSeq = 5_000;
  observe(analyser, frame(client, server, { seq, syn: true, timestamp: start }));
  observe(
    analyser,
    frame(server, client, {
      seq: synAckSeq,
      ack: seq + 1,
      syn: true,
      ackFlag: true,
      timestamp: start + synToSynAck,
    }),
  );
  observe(
    analyser,
    frame(client, server, {
      seq: seq + 1,
      ack: synAckSeq + 1,
      ackFlag: true,
      timestamp: start + synToSynAck + synAckToAck,
    }),
  );
}

function resultFor(analyser: HandshakeAnalyser, client: Endpoint): HandshakeResult {
  const result = analyser.results().find((entry) => entry.client.port === client.port);
  assert.notEqual(result, undefined, `no result for ${client.ip}:${client.port}`);
  return result!;
}

test('measures SYN → SYN-ACK → ACK deltas and the halved RTT estimate', () => {
  const { analyser } = createHarness();
  completeConnection(analyser, CLIENT, SERVER, 1_000, 200, 200);

  const result = resultFor(analyser, CLIENT);
  assert.equal(result.synToSynAckMs, 200);
  assert.equal(result.synAckToAckMs, 200);
  assert.equal(result.totalMs, 400);
  assert.equal(result.rttEstimateMs, 200);
  assert.equal(result.connectionId, `${CLIENT.ip}:${CLIENT.port}>${SERVER.ip}:${SERVER.port}`);
  assert.equal(result.synRetransmits, 0);
  assert.equal(analyser.inProgressCount, 0);
  assert.equal(analyser.completedCount, 1);
});

test('a SYN-ACK without a preceding SYN is not a new connection', () => {
  const { analyser } = createHarness();
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 1_001, syn: true, ackFlag: true, timestamp: 1_000 }),
  );

  assert.equal(analyser.inProgressCount, 0);
  assert.equal(analyser.completedCount, 0);
  assert.equal(analyser.snapshot().synAckMismatches, 0);
});

test('a SYN-ACK acknowledging the wrong sequence is not matched', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 9_999, syn: true, ackFlag: true, timestamp: 1_200 }),
  );

  assert.equal(analyser.inProgressCount, 1);
  assert.equal(analyser.completedCount, 0);
  assert.equal(analyser.snapshot().synAckMismatches, 1);

  // Without a matched SYN-ACK there is nothing for a final ACK to complete.
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, timestamp: 1_400 }),
  );
  assert.equal(analyser.completedCount, 0);
  assert.equal(analyser.snapshot().ackMismatches, 0);
});

test('a final ACK acknowledging the wrong sequence does not complete the handshake', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 1_001, syn: true, ackFlag: true, timestamp: 1_200 }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 9_999, ackFlag: true, timestamp: 1_400 }),
  );

  assert.equal(analyser.completedCount, 0);
  assert.equal(analyser.inProgressCount, 1);
  assert.equal(analyser.snapshot().ackMismatches, 1);
});

test('a retransmitted SYN is counted, not treated as a new connection', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_100 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 1_001, syn: true, ackFlag: true, timestamp: 1_300 }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, timestamp: 1_500 }),
  );

  assert.equal(analyser.inProgressCount, 0);
  assert.equal(analyser.completedCount, 1);

  const result = resultFor(analyser, CLIENT);
  assert.equal(result.synRetransmits, 1);
  // The handshake started at the first SYN, not the retransmission.
  assert.equal(result.synToSynAckMs, 300);
  assert.equal(result.totalMs, 500);
  assert.equal(result.rttEstimateMs, 250);
});

test('a SYN with a new ISN on the same 5-tuple replaces the abandoned attempt', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(analyser, frame(CLIENT, SERVER, { seq: 2_000, syn: true, timestamp: 2_000 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 9_000, ack: 2_001, syn: true, ackFlag: true, timestamp: 2_100 }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 2_001, ack: 9_001, ackFlag: true, timestamp: 2_200 }),
  );

  assert.equal(analyser.completedCount, 1);
  assert.equal(analyser.snapshot().staleCount, 1);
  const result = resultFor(analyser, CLIENT);
  assert.equal(result.totalMs, 200);
  assert.equal(result.synRetransmits, 0);
});

test('concurrent connections on distinct 5-tuples are tracked separately', () => {
  const { analyser } = createHarness();
  const other = { ip: '192.168.1.11', port: 51_001 };

  // Interleaved: A's SYN, B's SYN, A's SYN-ACK, B's SYN-ACK, A's ACK, B's ACK.
  completeConnection(analyser, CLIENT, SERVER, 1_000, 100, 100);
  completeConnection(analyser, other, SERVER, 1_000, 500, 500);

  const a = resultFor(analyser, CLIENT);
  const b = resultFor(analyser, other);
  assert.equal(a.totalMs, 200);
  assert.equal(b.totalMs, 1_000);
  assert.notEqual(a.connectionId, b.connectionId);
});

test('two connections between the same hosts are distinguished by port', () => {
  const { analyser } = createHarness();
  const first = { ip: '10.0.0.1', port: 40_000 };
  const second = { ip: '10.0.0.1', port: 40_001 };

  completeConnection(analyser, first, SERVER, 1_000, 10, 10);
  completeConnection(analyser, second, SERVER, 1_000, 20, 20);

  assert.equal(analyser.results().length, 2);
  assert.notEqual(resultFor(analyser, first).connectionId, resultFor(analyser, second).connectionId);
});

test('an ACK observed before the SYN-ACK does not complete the handshake', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, timestamp: 1_100 }),
  );
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 1_001, syn: true, ackFlag: true, timestamp: 1_200 }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, timestamp: 1_300 }),
  );

  assert.equal(analyser.completedCount, 1);
  const result = resultFor(analyser, CLIENT);
  assert.equal(result.totalMs, 300);
  assert.equal(result.synAckToAckMs, 100);
});

test('a duplicate final ACK does not double-count a connection', () => {
  const { analyser } = createHarness();
  completeConnection(analyser, CLIENT, SERVER, 1_000, 100, 100);
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, timestamp: 1_600 }),
  );

  assert.equal(analyser.completedCount, 1);
  assert.equal(analyser.results().length, 1);
});

test('a RST+ACK does not complete the handshake', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, { seq: 5_000, ack: 1_001, syn: true, ackFlag: true, timestamp: 1_200 }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 1_001, ack: 5_001, ackFlag: true, rst: true, timestamp: 1_400 }),
  );

  assert.equal(analyser.completedCount, 0);
  assert.equal(analyser.inProgressCount, 1);
});

test('sequence-number wraparound at 2^32 is handled', () => {
  const { analyser } = createHarness();
  observe(analyser, frame(CLIENT, SERVER, { seq: 0xffff_ffff, syn: true, timestamp: 1_000 }));
  observe(
    analyser,
    frame(SERVER, CLIENT, {
      seq: 0xffff_fffe,
      ack: 0x0000_0000,
      syn: true,
      ackFlag: true,
      timestamp: 1_200,
    }),
  );
  observe(
    analyser,
    frame(CLIENT, SERVER, { seq: 0x0000_0000, ack: 0xffff_ffff, ackFlag: true, timestamp: 1_400 }),
  );

  assert.equal(analyser.completedCount, 1);
  const result = resultFor(analyser, CLIENT);
  assert.equal(result.synSeq, 0xffff_ffff);
  assert.equal(result.synAckSeq, 0xffff_fffe);
  assert.equal(result.totalMs, 400);
});

test('in-progress connections expire and the registry stays bounded', () => {
  const { analyser, setClock } = createHarness({ staleAfterMs: 5_000 });
  observe(analyser, frame(CLIENT, SERVER, { seq: 1_000, syn: true, timestamp: 1_000 }));

  // Exactly at the threshold is still live; one millisecond past is stale.
  assert.equal(analyser.sweep(6_000), 0);
  assert.equal(analyser.inProgressCount, 1);

  setClock(6_001);
  assert.equal(analyser.sweep(), 1);
  assert.equal(analyser.inProgressCount, 0);
  assert.equal(analyser.snapshot().staleCount, 1);
  assert.equal(analyser.completedCount, 0);
});

test('the completed history is bounded by maxCompleted', () => {
  const { analyser } = createHarness({ maxCompleted: 2 });
  for (let index = 0; index < 3; index += 1) {
    completeConnection(
      analyser,
      { ip: '10.0.0.2', port: 41_000 + index },
      SERVER,
      1_000 + index * 10,
      10,
      10,
    );
  }

  assert.equal(analyser.results().length, 2);
  assert.equal(analyser.completedCount, 3);
  assert.equal(analyser.snapshot().windowSize, 2);
});

test('aggregate stats describe the retained window', () => {
  const { analyser } = createHarness();
  completeConnection(analyser, { ip: '10.0.0.3', port: 42_000 }, SERVER, 1_000, 100, 100);
  completeConnection(analyser, { ip: '10.0.0.3', port: 42_001 }, SERVER, 2_000, 200, 200);
  completeConnection(analyser, { ip: '10.0.0.3', port: 42_002 }, SERVER, 3_000, 300, 300);
  completeConnection(analyser, { ip: '10.0.0.3', port: 42_003 }, SERVER, 4_000, 400, 400);

  const snapshot = analyser.snapshot();
  const rtt = snapshot.rttEstimateMs;
  assert.notEqual(rtt, null);
  assert.equal(rtt!.count, 4);
  assert.equal(rtt!.min, 100);
  assert.equal(rtt!.max, 400);
  assert.equal(rtt!.mean, 250);
  // Nearest-rank percentile: p50 is the 2nd of 4 sorted samples.
  assert.equal(rtt!.p50, 200);
  assert.equal(rtt!.p95, 400);
  assert.equal(rtt!.p99, 400);
  assert.equal(snapshot.totalMs!.min, 200);
  assert.equal(snapshot.totalMs!.max, 800);
});

test('the publisher receives per-connection results and aggregate snapshots', () => {
  const connections: HandshakeResult[] = [];
  const aggregates: HandshakeAggregate[] = [];
  const { analyser } = createHarness({
    publisher: {
      publishConnection: (result) => {
        connections.push(result);
      },
      publishAggregate: (snapshot) => {
        aggregates.push(snapshot);
      },
    },
  });

  completeConnection(analyser, CLIENT, SERVER, 1_000, 100, 100);
  assert.equal(connections.length, 1);
  assert.equal(aggregates.length, 0);

  analyser.tick();
  assert.equal(aggregates.length, 1);
  assert.equal(aggregates[0]!.completedCount, 1);
});

test('the console publisher stays quiet when nothing has been captured', () => {
  const lines: string[] = [];
  const publisher = createConsoleHandshakePublisher((line) => {
    lines.push(line);
  });
  const { analyser } = createHarness({ publisher });

  analyser.tick();
  assert.equal(lines.length, 0);
});

test('the console publisher emits one line per connection and per sweep', () => {
  const lines: string[] = [];
  const publisher = createConsoleHandshakePublisher((line) => {
    lines.push(line);
  });
  const { analyser } = createHarness({ publisher });

  completeConnection(analyser, CLIENT, SERVER, 1_000, 200, 200);
  analyser.tick();

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^handshake 192\.168\.1\.10:51000>/);
  assert.match(lines[0]!, /total=400ms/);
  assert.match(lines[0]!, /rtt≈200\.0ms/);
  assert.match(lines[1]!, /^handshake-aggregate completed=1/);
});
