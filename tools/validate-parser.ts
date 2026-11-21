#!/usr/bin/env -S node --import tsx
// F8 — compare our packet parser against a tshark reference for one capture.
//
// USAGE
//   apps/proxy/node_modules/.bin/tsx tools/validate-parser.ts <file.pcap> <tshark.tsv>
//
//   <tshark.tsv> is produced by tools/validate-parser.sh with:
//     tshark -r file.pcap -o tcp.relative_sequence_numbers:false -Y "ip && tcp" \
//       -T fields -E separator=/t -E quote=n -E occurrence=f \
//       -e frame.number -e tcp.flags -e tcp.seq -e tcp.ack \
//       -e tcp.window_size_value -e tcp.options.mss_val \
//       -e tcp.options.wscale.shift -e tcp.options.timestamp.tsval \
//       -e tcp.options.timestamp.tsecr -e frame.time_epoch
//
// WHY A COMPARATOR AND NOT A RAW `diff`
//   Two frames are the same frame only if their frame.number matches: our
//   parser skips non-IPv4/TCP frames (e.g. IPv6) that tshark's display filter
//   also omits, so the two sides must be aligned by number, not by line order.
//   Timestamps are compared to microsecond tolerance, not exact equality.
//   The pure comparison logic lives in apps/proxy/src/l4/parser-validation.ts
//   and is unit-tested; this file only does the file I/O and printing.
//
// EXIT CODE
//   0 when every matched frame agrees and neither side has an unmatched frame;
//   1 otherwise. Any difference is a finding, not a nuisance.

import { readFileSync } from 'node:fs';

import { parsePacket } from '../apps/proxy/src/l4/packet-parser.js';
import {
  compareCaptures,
  rowFromPacket,
  rowFromTshark,
} from '../apps/proxy/src/l4/parser-validation.js';
import type { ValidationRow } from '../apps/proxy/src/l4/parser-validation.js';

interface OurRows {
  rows: ValidationRow[];
  totalFrames: number;
  skipped: number;
}

/** Read a pcap and decode every IPv4/TCP frame with the proxy's own parser. */
function readOurRows(pcapPath: string): OurRows {
  const buffer = readFileSync(pcapPath);
  if (buffer.length < 24) throw new Error(`${pcapPath}: too short to be a pcap file`);

  // Classic pcap: two resolutions (usec/nsec) and two byte orders. Read the
  // magic little-endian and accept all four, exactly as handshake-replay.ts does.
  const rawMagic = buffer.readUInt32LE(0);
  const isLittleEndian = rawMagic === 0xa1b2c3d4 || rawMagic === 0xa1b23c4d;
  const isNanosecond = rawMagic === 0xa1b23c4d || rawMagic === 0x4d3cb2a1;
  if (!isLittleEndian && rawMagic !== 0xd4c3b2a1 && rawMagic !== 0x4d3cb2a1) {
    throw new Error(`${pcapPath}: not a pcap file (magic 0x${rawMagic.toString(16)})`);
  }
  const readU32 = (offset: number): number =>
    isLittleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const unitsPerSecond = isNanosecond ? 1_000_000_000 : 1_000_000;
  const linkType = readU32(20); // global header "network" field

  const rows: ValidationRow[] = [];
  let offset = 24;
  let frameNumber = 0;
  let skipped = 0;
  while (offset + 16 <= buffer.length) {
    const tsSec = readU32(offset);
    const tsFrac = readU32(offset + 4);
    const inclLen = readU32(offset + 8);
    const origLen = readU32(offset + 12);
    offset += 16;
    frameNumber += 1;
    if (offset + inclLen > buffer.length) {
      throw new Error(`${pcapPath}: truncated final packet record`);
    }
    const bytes = buffer.subarray(offset, offset + inclLen);
    offset += inclLen;

    // The timestamp comes from the capture record header (both sides read the
    // same header), not ParsedPacket.timestamp, which is whole milliseconds.
    const timeEpoch = tsSec + tsFrac / unitsPerSecond;
    const packet = parsePacket({
      bytes,
      timestamp: Math.floor(timeEpoch * 1_000),
      capturedLength: inclLen,
      originalLength: origLen,
      linkType,
    });
    if (packet === null) {
      skipped += 1; // non-IPv4/TCP (e.g. IPv6) — out of the parser's scope
      continue;
    }
    rows.push(rowFromPacket(packet, frameNumber, timeEpoch));
  }
  return { rows, totalFrames: frameNumber, skipped };
}

/** Read the tshark `-T fields` TSV into reference rows, keyed by frame number. */
function readReferenceRows(tsvPath: string): ValidationRow[] {
  const text = readFileSync(tsvPath, 'utf8');
  const rows: ValidationRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = rowFromTshark(line.split('\t'));
    if (row !== null) rows.push(row);
  }
  return rows;
}

const pcapPath = process.argv[2];
const tsvPath = process.argv[3];
if (pcapPath === undefined || tsvPath === undefined) {
  console.error('usage: validate-parser.ts <file.pcap> <tshark.tsv>');
  process.exit(2);
}

const ours = readOurRows(pcapPath);
const reference = readReferenceRows(tsvPath);
const comparison = compareCaptures(ours.rows, reference);

console.log(`capture: ${pcapPath}`);
console.log(
  `our parser: ${ours.rows.length} IPv4/TCP frames decoded, ` +
    `${ours.skipped} skipped (non-IPv4/TCP), ${ours.totalFrames} total frames`,
);
console.log(`tshark:     ${reference.length} IPv4/TCP reference rows`);
console.log(`matched frames: ${comparison.matchedFrames}`);

for (const frame of comparison.missingInOurs) {
  console.log(`  frame ${frame}: tshark decoded it but our parser skipped it`);
}
for (const frame of comparison.missingInReference) {
  console.log(`  frame ${frame}: our parser decoded it but tshark omitted it`);
}
for (const diff of comparison.discrepancies) {
  console.log(`  frame ${diff.frameNumber} ${diff.field}: ours=${diff.ours} tshark=${diff.reference}`);
}

const failed =
  comparison.discrepancies.length > 0 ||
  comparison.missingInOurs.length > 0 ||
  comparison.missingInReference.length > 0;
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
