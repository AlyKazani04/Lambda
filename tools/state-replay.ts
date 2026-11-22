#!/usr/bin/env -S node --import tsx
// Replay a capture through the B6 TCP state machine without capture privileges.
//
//   tools/state-replay.sh [file.pcap]
//
// Prints one line per state change. When REDIS_URL is set, also publishes each
// change to the tcp-state channel through the proxy's own bus, so the dashboard's
// Connections view receives the same events a live capture would produce.

import { readFileSync } from 'node:fs';

import { parsePacket } from '../apps/proxy/src/l4/packet-parser.js';
import { TcpStateMachine } from '../apps/proxy/src/l4/state-machine.js';
import { createFrameBus } from '../apps/proxy/src/bus/redis.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: state-replay.ts <file.pcap>');
  process.exit(2);
}

const buffer = readFileSync(path);
if (buffer.length < 24) throw new Error(`${path}: too short to be a pcap file`);

const rawMagic = buffer.readUInt32LE(0);
const isLittleEndian = rawMagic === 0xa1b2c3d4 || rawMagic === 0xa1b23c4d;
const isNanosecond = rawMagic === 0xa1b23c4d || rawMagic === 0x4d3cb2a1;
if (!isLittleEndian && rawMagic !== 0xd4c3b2a1 && rawMagic !== 0x4d3cb2a1) {
  throw new Error(`${path}: not a pcap file`);
}
const readU32 = (offset: number): number =>
  isLittleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
const unitsPerSecond = isNanosecond ? 1_000_000_000 : 1_000_000;

const redisUrl = (process.env.REDIS_URL ?? '').trim();
const bus = redisUrl === '' ? null : createFrameBus({ url: redisUrl, historyLimit: 10_000 });
if (bus !== null) {
  await Promise.race([
    bus.ready(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`redis not ready at ${redisUrl}`)), 5_000)),
  ]);
}

const machine = new TcpStateMachine({
  publish: (event) => {
    console.log(
      `${event.connectionId} ${event.state} t=${event.timestamp} rst=${event.rstCount}`,
    );
    bus?.publishTcpState(event);
  },
});

let offset = 24;
let parsed = 0;
let skipped = 0;
while (offset + 16 <= buffer.length) {
  const tsSec = readU32(offset);
  const tsFrac = readU32(offset + 4);
  const inclLen = readU32(offset + 8);
  const origLen = readU32(offset + 12);
  offset += 16;
  if (offset + inclLen > buffer.length) throw new Error(`${path}: truncated packet`);
  const bytes = buffer.subarray(offset, offset + inclLen);
  offset += inclLen;

  const timeEpoch = tsSec + tsFrac / unitsPerSecond;
  const packet = parsePacket({
    bytes,
    timestamp: Math.floor(timeEpoch * 1_000),
    capturedLength: inclLen,
    originalLength: origLen,
    linkType: readU32(20),
  });
  if (packet === null) {
    skipped += 1;
    continue;
  }
  parsed += 1;
  machine.observe(packet);
}

const snapshot = machine.states();
console.log(
  `replay ${path}: parsed=${parsed} skipped=${skipped} ` +
    `connections=${snapshot.size} rst=${machine.rstCount}`,
);
await bus?.close();
