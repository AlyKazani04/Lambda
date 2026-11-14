// Replay a captured pcap through the B3 handshake analyser.
//
// WHY THIS EXISTS
//   Live capture needs CAP_NET_RAW and a second machine to generate traffic
//   across the physical NIC. This tool needs neither: it reads the .pcap the
//   proxy already writes (PCAP_EXPORT_PATH, F6/B9) and runs the exact same
//   decode + analyse path, so a netem run can be evaluated offline and
//   reproducibly.
//
// USAGE
//   apps/proxy/node_modules/.bin/tsx tools/handshake-replay.ts [file.pcap]
//   tools/handshake-replay.sh apps/proxy/capture.pcap
//
// WHAT IT PRINTS
//   One line per completed handshake, then one aggregate line. Under a netem
//   profile of 20ms ± 5ms the RTT estimate should land near 20ms; on loopback
//   it is ~0ms because the whole handshake is sub-millisecond.

import { readFileSync } from 'node:fs';

import { parsePacket } from '../apps/proxy/src/l4/packet-parser.js';
import {
  createConsoleHandshakePublisher,
  HandshakeAnalyser,
} from '../apps/proxy/src/l4/handshake.js';

const path = process.argv[2] ?? 'capture.pcap';
const buffer = readFileSync(path);

if (buffer.length < 24) {
  console.error(`${path}: too short to be a pcap file`);
  process.exit(1);
}

const magic = buffer.readUInt32LE(0);
if (magic !== 0xa1b2c3d4 && magic !== 0xd4c3b2a1) {
  console.error(`${path}: not a pcap file (magic 0x${magic.toString(16)})`);
  process.exit(1);
}

// The sweep clock is only used for expiry; pinning it to the last packet time
// means replay never expires a connection that the capture simply ended on.
let clock = 0;
const analyser = new HandshakeAnalyser({
  sweepIntervalMs: 0,
  now: () => clock,
  publisher: createConsoleHandshakePublisher(),
});

let offset = 24; // pcap global header
let parsed = 0;
let skipped = 0;

while (offset + 16 <= buffer.length) {
  const tsSec = buffer.readUInt32LE(offset);
  const tsUsec = buffer.readUInt32LE(offset + 4);
  const inclLen = buffer.readUInt32LE(offset + 8);
  const origLen = buffer.readUInt32LE(offset + 12);
  offset += 16;

  if (offset + inclLen > buffer.length) {
    console.error(`${path}: truncated final packet (need ${inclLen}, have ${buffer.length - offset})`);
    process.exit(1);
  }

  const bytes = buffer.subarray(offset, offset + inclLen);
  offset += inclLen;

  const timestamp = tsSec * 1000 + Math.floor(tsUsec / 1000);
  clock = Math.max(clock, timestamp);

  const packet = parsePacket({
    bytes,
    timestamp,
    capturedLength: inclLen,
    originalLength: origLen,
    linkType: 1,
  });
  // Non-IPv4 frames (the IPv6 loopback handshakes on ::1, for instance) are
  // skipped by the parser by design.
  if (packet === null) {
    skipped += 1;
    continue;
  }

  parsed += 1;
  analyser.observe(packet);
}

analyser.tick();
const snapshot = analyser.snapshot();
console.log(
  `replay ${path}: parsed=${parsed} skipped=${skipped} ` +
    `completed=${snapshot.completedCount} inProgress=${snapshot.inProgressCount} ` +
    `stale=${snapshot.staleCount} synAckMismatches=${snapshot.synAckMismatches} ` +
    `ackMismatches=${snapshot.ackMismatches}`,
);
