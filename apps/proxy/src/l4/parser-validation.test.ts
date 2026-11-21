// Unit tests for F8 differential parser validation (pure comparison logic).
//
// Like the B3 tests, these build real Ethernet/IPv4/TCP bytes and run them
// through the same parsePacket() the proxy uses, so the "our side" rows come
// from the actual decode path rather than a test-only shortcut. The tshark
// reference rows are literal strings copied from real `tshark -T fields`
// output, so the reference parser is tested against ground truth too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket } from 'shared-types';

import { parsePacket } from './packet-parser.js';
import {
  compareCaptures,
  compareRows,
  formatFlags,
  rowFromPacket,
  rowFromTshark,
  TIMESTAMP_TOLERANCE_SECONDS,
  TSHARK_COLUMNS,
} from './parser-validation.js';
import type { ValidationRow } from './parser-validation.js';

const ETHERTYPE_IPV4 = 0x0800;

interface TcpSpec {
  srcPort?: number;
  dstPort?: number;
  seq: number;
  ack?: number;
  /** Raw flags byte (FIN=1 SYN=2 RST=4 PSH=8 ACK=16 ...). */
  flags: number;
  window?: number;
  mss?: number;
  wscale?: number;
  tsVal?: number;
  tsEcr?: number;
  payload?: Buffer;
}

/** Append one TCP option, NOP-padding so the header stays 4-byte aligned. */
function pushOption(bytes: number[], kind: number, value: number[]): void {
  bytes.push(kind, value.length + 2, ...value);
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/** Build a structurally valid Ethernet + IPv4 + TCP frame with options. */
function buildFrame(spec: TcpSpec): Buffer {
  const optionBytes: number[] = [];
  if (spec.mss !== undefined) pushOption(optionBytes, 2, u16(spec.mss));
  if (spec.wscale !== undefined) pushOption(optionBytes, 3, [spec.wscale]);
  if (spec.tsVal !== undefined && spec.tsEcr !== undefined) {
    pushOption(optionBytes, 8, [...u32(spec.tsVal), ...u32(spec.tsEcr)]);
  }
  // Pad with NOP (kind 1) to a 4-byte boundary, then EOL (kind 0).
  while (optionBytes.length % 4 !== 0) optionBytes.push(1);
  const dataOffset = 5 + optionBytes.length / 4;

  const payload = spec.payload ?? Buffer.alloc(0);
  const tcp = Buffer.alloc(20 + optionBytes.length + payload.length);
  tcp.writeUInt16BE(spec.srcPort ?? 51_000, 0);
  tcp.writeUInt16BE(spec.dstPort ?? 8080, 2);
  tcp.writeUInt32BE(spec.seq >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt8((dataOffset << 4) & 0xf0, 12);
  tcp.writeUInt8(spec.flags & 0xff, 13);
  tcp.writeUInt16BE(spec.window ?? 65_535, 14);
  tcp.writeUInt16BE(0, 16); // checksum: parsePacket does not validate it
  tcp.writeUInt16BE(0, 18);
  Buffer.from(optionBytes).copy(tcp, 20);
  payload.copy(tcp, 20 + optionBytes.length);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(20 + tcp.length, 2);
  ip.writeUInt8(64, 8);
  ip.writeUInt8(6, 9); // protocol TCP
  ip.writeUInt32BE(0x7f00_0001, 12); // 127.0.0.1
  ip.writeUInt32BE(0x7f00_0001, 16);

  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(ETHERTYPE_IPV4, 12);

  return Buffer.concat([eth, ip, tcp]);
}

function parse(spec: TcpSpec): ParsedPacket {
  const bytes = buildFrame(spec);
  const parsed = parsePacket({
    bytes,
    timestamp: 1_000,
    capturedLength: bytes.length,
    originalLength: bytes.length,
    linkType: 1,
  });
  assert.notEqual(parsed, null, 'fixture must parse');
  return parsed!;
}

/** A baseline row that every field-comparison test mutates one field of. */
function baseRow(overrides: Partial<ValidationRow> = {}): ValidationRow {
  return {
    frameNumber: 1,
    flags: 0x12,
    seq: 1_000,
    ack: 2_000,
    window: 64,
    mss: 1_460,
    windowScale: 7,
    tsVal: 111,
    tsEcr: 222,
    timeEpoch: 1_700_000_000.000_001,
    ...overrides,
  };
}

// --- formatFlags -----------------------------------------------------------

test('formatFlags prints tshark-style 0x-prefixed, 4-digit lowercase hex', () => {
  assert.equal(formatFlags(0x02), '0x0002'); // SYN
  assert.equal(formatFlags(0x12), '0x0012'); // SYN+ACK
  assert.equal(formatFlags(0x18), '0x0018'); // PSH+ACK
  assert.equal(formatFlags(0x11), '0x0011'); // FIN+ACK
  assert.equal(formatFlags(0x14), '0x0014'); // RST+ACK
});

test('formatFlags keeps the NS bit (9th flag) in the hex value', () => {
  assert.equal(formatFlags(0x114), '0x0114'); // NS + RST + ACK
});

// --- rowFromPacket ---------------------------------------------------------

test('rowFromPacket projects the parser’s raw fields, not derived ones', () => {
  const packet = parse({
    seq: 368_461_270,
    ack: 0,
    flags: 0x02,
    window: 65_495,
    mss: 65_495,
    wscale: 10,
    tsVal: 2_172_967_376,
    tsEcr: 0,
  });
  const row = rowFromPacket(packet, 3, 1_793_690_653.369);
  assert.equal(row.frameNumber, 3);
  assert.equal(row.flags, 0x02);
  assert.equal(row.seq, 368_461_270); // absolute, not relative 0
  assert.equal(row.ack, 0);
  assert.equal(row.window, 65_495); // raw field, not scaled
  assert.equal(row.mss, 65_495);
  assert.equal(row.windowScale, 10);
  assert.equal(row.tsVal, 2_172_967_376);
  assert.equal(row.tsEcr, 0);
  assert.equal(row.timeEpoch, 1_793_690_653.369);
});

test('rowFromPacket reports absent options as null', () => {
  const packet = parse({ seq: 5, ack: 9, flags: 0x10, window: 64 });
  const row = rowFromPacket(packet, 5, 100);
  assert.equal(row.mss, null);
  assert.equal(row.windowScale, null);
  assert.equal(row.tsVal, null);
  assert.equal(row.tsEcr, null);
});

// --- rowFromTshark ---------------------------------------------------------

test('rowFromTshark parses a real tshark line into the same shape', () => {
  // Copied from: tshark -o tcp.relative_sequence_numbers:false -Y "ip && tcp"
  //   -T fields -E separator=/t on apps/proxy/capture.pcap, frame 4.
  const line = [
    '4', '0x0012', '2991238105', '368461271', '65483',
    '65495', '10', '3809759681', '2172967376', '1793690653.369000000',
  ];
  const row = rowFromTshark(line);
  assert.notEqual(row, null);
  assert.equal(row!.frameNumber, 4);
  assert.equal(row!.flags, 0x12);
  assert.equal(row!.seq, 2_991_238_105);
  assert.equal(row!.ack, 368_461_271);
  assert.equal(row!.window, 65_483);
  assert.equal(row!.mss, 65_495);
  assert.equal(row!.windowScale, 10);
  assert.equal(row!.tsVal, 3_809_759_681);
  assert.equal(row!.tsEcr, 2_172_967_376);
  assert.equal(row!.timeEpoch, 1_793_690_653.369);
});

test('rowFromTshark maps empty optional columns to null', () => {
  const line = [
    '5', '0x0010', '368461271', '2991238106', '64',
    '', '', '2172967376', '3809759681', '1793690653.369000000',
  ];
  const row = rowFromTshark(line);
  assert.notEqual(row, null);
  assert.equal(row!.mss, null);
  assert.equal(row!.windowScale, null);
  assert.equal(row!.tsVal, 2_172_967_376);
});

test('rowFromTshark rejects blank and short lines', () => {
  assert.equal(rowFromTshark([]), null);
  assert.equal(rowFromTshark(['1', '0x0002']), null);
  assert.equal(rowFromTshark(['', '', '', '', '', '', '', '', '', '']), null);
});

test('TSHARK_COLUMNS has one entry per parsed field', () => {
  assert.equal(TSHARK_COLUMNS.length, 10);
});

// --- compareRows -----------------------------------------------------------

test('compareRows returns nothing for identical rows', () => {
  assert.deepEqual(compareRows(baseRow(), baseRow()), []);
});

test('compareRows flags a differing absolute sequence number', () => {
  const diffs = compareRows(baseRow({ seq: 1_000 }), baseRow({ seq: 1_001 }));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.field, 'seq');
  assert.equal(diffs[0]!.ours, '1000');
  assert.equal(diffs[0]!.reference, '1001');
});

test('compareRows distinguishes an absent option from a present one', () => {
  const diffs = compareRows(baseRow({ mss: null }), baseRow({ mss: 1_460 }));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.field, 'mss');
  assert.equal(diffs[0]!.ours, '(absent)');
  assert.equal(diffs[0]!.reference, '1460');
});

test('compareRows accepts timestamps within microsecond tolerance', () => {
  const ours = baseRow({ timeEpoch: 1_700_000_000.000_001 });
  const ref = baseRow({ timeEpoch: 1_700_000_000.000_001_4 });
  assert.ok(Math.abs(ours.timeEpoch - ref.timeEpoch) < TIMESTAMP_TOLERANCE_SECONDS);
  assert.deepEqual(compareRows(ours, ref), []);
});

test('compareRows flags timestamps beyond microsecond tolerance', () => {
  const ours = baseRow({ timeEpoch: 1_700_000_000.0 });
  const ref = baseRow({ timeEpoch: 1_700_000_000.002 }); // 2 ms apart
  const diffs = compareRows(ours, ref);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]!.field, 'timeEpoch');
});

test('compareRows reports every differing field, not just the first', () => {
  const diffs = compareRows(
    baseRow({ seq: 1, ack: 2, window: 3 }),
    baseRow({ seq: 9, ack: 8, window: 7 }),
  );
  assert.deepEqual(diffs.map((d) => d.field).sort(), ['ack', 'seq', 'window']);
});

// --- compareCaptures -------------------------------------------------------

test('compareCaptures aligns rows by frame number, not by position', () => {
  // Our parser skips the IPv6 frames 1 and 2; tshark -Y "ip && tcp" also
  // omits them, so both sides start at frame 3 but in different orders.
  const ours = [baseRow({ frameNumber: 4 }), baseRow({ frameNumber: 3 })];
  const ref = [baseRow({ frameNumber: 3 }), baseRow({ frameNumber: 4 })];
  const result = compareCaptures(ours, ref);
  assert.equal(result.matchedFrames, 2);
  assert.deepEqual(result.discrepancies, []);
  assert.deepEqual(result.missingInOurs, []);
  assert.deepEqual(result.missingInReference, []);
});

test('compareCaptures reports a frame tshark saw but our parser skipped', () => {
  const ours = [baseRow({ frameNumber: 3 })];
  const ref = [baseRow({ frameNumber: 3 }), baseRow({ frameNumber: 4 })];
  const result = compareCaptures(ours, ref);
  assert.equal(result.matchedFrames, 1);
  assert.deepEqual(result.missingInOurs, [4]);
  assert.deepEqual(result.missingInReference, []);
});

test('compareCaptures reports a frame our parser saw but tshark did not', () => {
  const ours = [baseRow({ frameNumber: 3 }), baseRow({ frameNumber: 4 })];
  const ref = [baseRow({ frameNumber: 3 })];
  const result = compareCaptures(ours, ref);
  assert.deepEqual(result.missingInReference, [4]);
});

test('compareCaptures aggregates per-field discrepancies across frames', () => {
  const ours = [baseRow({ frameNumber: 3, seq: 100 }), baseRow({ frameNumber: 4 })];
  const ref = [baseRow({ frameNumber: 3, seq: 999 }), baseRow({ frameNumber: 4 })];
  const result = compareCaptures(ours, ref);
  assert.equal(result.matchedFrames, 2);
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.frameNumber, 3);
  assert.equal(result.discrepancies[0]!.field, 'seq');
});
