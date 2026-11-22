// B6 — TCP state machine unit tests over real decoded frames.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket } from 'shared-types';

import { parsePacket } from './packet-parser.js';
import { TcpStateMachine } from './state-machine.js';

const ETHERTYPE_IPV4 = 0x0800;
const SYN = 0x02;
const ACK = 0x10;
const SYN_ACK = 0x12;
const FIN = 0x01;
const FIN_ACK = 0x11;
const RST = 0x04;

function ipToBytes(ip: string): number[] {
  return ip.split('.').map(Number);
}

function frame(spec: {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  flags: number;
  seq?: number;
  ack?: number;
}): Buffer {
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(spec.srcPort, 0);
  tcp.writeUInt16BE(spec.dstPort, 2);
  tcp.writeUInt32BE((spec.seq ?? 1_000) >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt8(0x50, 12);
  tcp.writeUInt8(spec.flags, 13);
  tcp.writeUInt16BE(65_535, 14);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(40, 2);
  ip.writeUInt8(6, 9);
  const src = ipToBytes(spec.src);
  const dst = ipToBytes(spec.dst);
  for (let i = 0; i < 4; i += 1) {
    ip.writeUInt8(src[i]!, 12 + i);
    ip.writeUInt8(dst[i]!, 16 + i);
  }

  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(ETHERTYPE_IPV4, 12);
  return Buffer.concat([eth, ip, tcp]);
}

function packet(spec: {
  src: string;
  srcPort: number;
  dst: string;
  dstPort: number;
  flags: number;
  seq?: number;
  ack?: number;
  timestamp?: number;
}): ParsedPacket {
  const parsed = parsePacket({
    bytes: frame(spec),
    timestamp: spec.timestamp ?? 1_000,
    capturedLength: 48,
    originalLength: 48,
    linkType: 1,
  });
  assert.notEqual(parsed, null);
  return parsed!;
}

const CLIENT = { ip: '10.0.0.1', port: 51_000 };
const SERVER = { ip: '10.0.0.2', port: 8080 };
const CLIENT_KEY = '10.0.0.1:51000';
const KEY = `${CLIENT_KEY}|10.0.0.2:8080`;

function toServer(flags: number, ts = 1_000, port = CLIENT.port) {
  return packet({ src: CLIENT.ip, srcPort: port, dst: SERVER.ip, dstPort: SERVER.port, flags, timestamp: ts });
}
function toClient(flags: number, ts = 1_000, port = CLIENT.port) {
  return packet({ src: SERVER.ip, srcPort: SERVER.port, dst: CLIENT.ip, dstPort: port, flags, timestamp: ts });
}

function handshake(sm: TcpStateMachine): void {
  sm.observe(toServer(SYN, 1_000));
  sm.observe(toClient(SYN_ACK, 1_100));
  sm.observe(toServer(ACK, 1_200));
}

function view(sm: TcpStateMachine, key = KEY) {
  return sm.states().get(key);
}

test('handshake drives two complementary per-endpoint state machines', () => {
  const sm = new TcpStateMachine();
  sm.observe(toServer(SYN));
  assert.equal(view(sm)?.clientState, 'SYN_SENT');
  assert.equal(view(sm)?.serverState, 'SYN_RCVD');
  sm.observe(toClient(SYN_ACK));
  assert.equal(view(sm)?.clientState, 'ESTABLISHED');
  assert.equal(view(sm)?.serverState, 'SYN_RCVD');
  sm.observe(toServer(ACK));
  assert.equal(view(sm)?.serverState, 'ESTABLISHED');
  assert.equal(sm.size, 1);
});

test('a capture joined mid-handshake starts the server in SYN_RCVD', () => {
  const sm = new TcpStateMachine();
  sm.observe(toClient(SYN_ACK));
  assert.equal(view(sm)?.serverState, 'SYN_RCVD');
  assert.equal(view(sm)?.clientState, 'ESTABLISHED');
  sm.observe(toServer(ACK));
  assert.equal(view(sm)?.serverState, 'ESTABLISHED');
});

test('active close: FIN_WAIT_1 / CLOSE_WAIT then LAST_ACK and TIME_WAIT', () => {
  const sm = new TcpStateMachine();
  handshake(sm);
  sm.observe(toServer(FIN, 2_000));
  assert.equal(view(sm)?.clientState, 'FIN_WAIT_1');
  assert.equal(view(sm)?.serverState, 'CLOSE_WAIT');
  sm.observe(toClient(ACK, 2_100));
  assert.equal(view(sm)?.clientState, 'FIN_WAIT_2');
  sm.observe(toClient(FIN_ACK, 2_200));
  assert.equal(view(sm)?.serverState, 'LAST_ACK');
  assert.equal(view(sm)?.clientState, 'TIME_WAIT');
  sm.observe(toServer(ACK, 2_300));
  assert.equal(view(sm)?.serverState, null);
  assert.equal(view(sm)?.clientState, 'TIME_WAIT');
});

test('simultaneous close passes through CLOSING', () => {
  const sm = new TcpStateMachine();
  handshake(sm);
  sm.observe(toServer(FIN, 2_000));
  sm.observe(toClient(FIN, 2_010));
  assert.equal(view(sm)?.clientState, 'CLOSING');
  assert.equal(view(sm)?.serverState, 'LAST_ACK');
  sm.observe(toServer(ACK, 2_020));
  assert.equal(view(sm)?.clientState, 'TIME_WAIT');
});

test('RST from any state closes both endpoints immediately and is counted', () => {
  const sm = new TcpStateMachine();
  handshake(sm);
  sm.observe(toClient(RST, 3_000));
  assert.equal(sm.size, 0);
  assert.equal(sm.rstCount, 1);
  assert.equal(sm.recent().at(-1)?.state, 'CLOSED');
});

test('a /api/reset frame trace ID is attached to the RST closure event', () => {
  const sm = new TcpStateMachine();
  sm.associateTrace(CLIENT.ip, CLIENT.port, 'trace-42', '/api/reset');
  handshake(sm);
  sm.observe(toClient(RST, 3_000));
  const closed = sm.recent().find((event) => event.state === 'CLOSED');
  assert.equal(closed?.traceId, 'trace-42');
  assert.equal(closed?.path, '/api/reset');
});

test('TIME_WAIT survives idle expiry and emits a CLOSED event when it leaves', () => {
  const sm = new TcpStateMachine({ staleAfterMs: 1_000, timeWaitMs: 120_000 });
  handshake(sm);
  sm.observe(toServer(FIN, 2_000));
  sm.observe(toClient(ACK, 2_100));
  sm.observe(toClient(FIN_ACK, 2_200));
  assert.equal(view(sm)?.clientState, 'TIME_WAIT');

  const before = sm.recent().length;
  assert.equal(sm.sweep(10_000), 0);
  assert.equal(view(sm)?.clientState, 'TIME_WAIT');
  assert.equal(sm.sweep(122_201), 1);
  assert.equal(sm.size, 0);
  assert.equal(sm.recent().length, before + 2); // both sides emit CLOSED
  assert.equal(sm.recent().at(-1)?.state, 'CLOSED');
});

test('idle in-progress connections expire with a CLOSED event', () => {
  const sm = new TcpStateMachine({ staleAfterMs: 1_000 });
  sm.observe(toServer(SYN, 1_000));
  const before = sm.recent().length;
  assert.equal(sm.sweep(2_001), 1);
  assert.equal(sm.size, 0);
  assert.equal(sm.recent().length, before + 2); // both sides emit CLOSED
  assert.equal(sm.recent().at(-1)?.state, 'CLOSED');
});

test('a retransmitted SYN after ESTABLISHED is a logged no-op', () => {
  const lines: string[] = [];
  const sm = new TcpStateMachine({ onIllegal: (line) => lines.push(line) });
  handshake(sm);
  sm.observe(toServer(SYN, 1_500));
  assert.equal(view(sm)?.clientState, 'ESTABLISHED');
  assert.equal(view(sm)?.serverState, 'ESTABLISHED');
  assert.equal(sm.illegalCount, 1);
  assert.equal(lines.length, 1);
});

test('registry is hard-capped and evicts the least recently seen connection', () => {
  const sm = new TcpStateMachine({ maxConnections: 2 });
  sm.observe(toServer(SYN, 1_000, 51_001));
  sm.observe(toServer(SYN, 1_100, 51_002));
  sm.observe(toServer(SYN, 1_200, 51_003));
  assert.equal(sm.size, 2);
  assert.equal(view(sm, '10.0.0.1:51001|10.0.0.2:8080'), undefined);
  assert.equal(view(sm, '10.0.0.1:51002|10.0.0.2:8080')?.clientState, 'SYN_SENT');
  assert.equal(view(sm, '10.0.0.1:51003|10.0.0.2:8080')?.clientState, 'SYN_SENT');
});

test('history is bounded and every event carries the capture timestamp', () => {
  const published: number[] = [];
  const sm = new TcpStateMachine({ maxHistory: 3, publish: (event) => published.push(event.timestamp) });
  sm.observe(toServer(SYN, 12_345));
  sm.observe(toClient(SYN_ACK, 12_445));
  assert.equal(sm.recent().length, 3);
  assert.deepEqual(published, [12_345, 12_345, 12_445]);
});
