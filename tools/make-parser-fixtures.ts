#!/usr/bin/env -S node --import tsx
// F8 — generate deterministic parser-validation fixtures with our own writer.
//
// WHY THIS EXISTS
//   F8 must run against committed captures so a third party can reproduce the
//   validation without re-running a load test or holding capture privileges.
//   These fixtures are written by the SAME PcapWriter the proxy uses (F6/B9),
//   so producing them also dogfoods our file-format handling. Each one exercises
//   a different behaviour the real loopback capture does not cover on its own.
//
// USAGE
//   apps/proxy/node_modules/.bin/tsx tools/make-parser-fixtures.ts [outdir]
//
//   Defaults to tools/parser-fixtures/. The real loopback capture is copied in
//   separately (see tools/validate-parser.sh); this generator is self-contained
//   and deterministic, so it never depends on a live capture being present.
//
//   Fixtures:
//     reset.pcap       connection torn down by RST (the /api/reset behaviour)
//     retransmit.pcap  full + partial retransmits, dup ACKs, out-of-order (loss)
//     chunked.pcap     a response split across many PSH+ACK segments
//     options.pcap     MSS / window-scale / SACK / timestamps, truncation, wrap

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { PcapWriter } from '../apps/proxy/src/l4/pcap-writer.js';
import type { CapturedPacket } from '../apps/proxy/src/l4/capture.js';

const OUT_DIR = process.argv[2] ?? join(import.meta.dirname, 'parser-fixtures');
const ETHERTYPE_IPV4 = 0x0800;
const CLIENT = { ip: '10.0.0.1', port: 51_000 };
const SERVER = { ip: '10.0.0.2', port: 8080 };
// A fixed base so every run produces byte-identical files (reproducible diff).
const BASE_USEC = 1_700_000_000_000_000;

interface Endpoint {
  ip: string;
  port: number;
}

interface FrameSpec {
  src: Endpoint;
  dst: Endpoint;
  seq: number;
  ack?: number;
  /** Raw flags byte: FIN=1 SYN=2 RST=4 PSH=8 ACK=16. */
  flags: number;
  window?: number;
  mss?: number;
  wscale?: number;
  sackPermitted?: boolean;
  sackBlocks?: Array<[number, number]>;
  tsVal?: number;
  tsEcr?: number;
  payload?: Buffer;
  /** When set, capture only this many bytes (simulate a truncated capture). */
  capturedLength?: number;
}

function ipToBytes(ip: string): number[] {
  return ip.split('.').map((part) => Number(part));
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** One's-complement Internet checksum (RFC 1071), used for IP and TCP. */
function checksum(buffer: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < buffer.length; offset += 2) {
    // Pad an odd trailing byte with zero, as the RFC requires.
    const word =
      offset + 1 < buffer.length
        ? buffer.readUInt16BE(offset)
        : buffer[offset]! << 8;
    sum += word;
  }
  while (sum >> 16 !== 0) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function pushOption(bytes: number[], kind: number, value: number[]): void {
  bytes.push(kind, value.length + 2, ...value);
}

/** Build a complete, checksum-valid Ethernet + IPv4 + TCP frame. */
function buildFrame(spec: FrameSpec): Buffer {
  const optionBytes: number[] = [];
  if (spec.mss !== undefined) pushOption(optionBytes, 2, u16(spec.mss));
  if (spec.wscale !== undefined) pushOption(optionBytes, 3, [spec.wscale]);
  if (spec.sackPermitted === true) pushOption(optionBytes, 4, []);
  if (spec.sackBlocks !== undefined) {
    const blocks: number[] = [];
    for (const [left, right] of spec.sackBlocks) blocks.push(...u32(left), ...u32(right));
    pushOption(optionBytes, 5, blocks);
  }
  if (spec.tsVal !== undefined && spec.tsEcr !== undefined) {
    pushOption(optionBytes, 8, [...u32(spec.tsVal), ...u32(spec.tsEcr)]);
  }
  while (optionBytes.length % 4 !== 0) optionBytes.push(1); // NOP pad
  const dataOffset = 5 + optionBytes.length / 4;
  if (dataOffset > 15) throw new Error('TCP options exceed the 40-byte maximum');

  const payload = spec.payload ?? Buffer.alloc(0);
  const tcp = Buffer.alloc(20 + optionBytes.length + payload.length);
  tcp.writeUInt16BE(spec.src.port, 0);
  tcp.writeUInt16BE(spec.dst.port, 2);
  tcp.writeUInt32BE(spec.seq >>> 0, 4);
  tcp.writeUInt32BE((spec.ack ?? 0) >>> 0, 8);
  tcp.writeUInt8((dataOffset << 4) & 0xf0, 12);
  tcp.writeUInt8(spec.flags & 0xff, 13);
  tcp.writeUInt16BE(spec.window ?? 65_535, 14);
  tcp.writeUInt16BE(0, 16); // checksum filled below
  tcp.writeUInt16BE(0, 18);
  Buffer.from(optionBytes).copy(tcp, 20);
  payload.copy(tcp, 20 + optionBytes.length);

  // TCP checksum covers a pseudo-header + the TCP segment.
  const src = ipToBytes(spec.src.ip);
  const dst = ipToBytes(spec.dst.ip);
  const pseudo = Buffer.alloc(12);
  pseudo.writeUInt8(src[0]!, 0);
  pseudo.writeUInt8(src[1]!, 1);
  pseudo.writeUInt8(src[2]!, 2);
  pseudo.writeUInt8(src[3]!, 3);
  pseudo.writeUInt8(dst[0]!, 4);
  pseudo.writeUInt8(dst[1]!, 5);
  pseudo.writeUInt8(dst[2]!, 6);
  pseudo.writeUInt8(dst[3]!, 7);
  pseudo.writeUInt8(0, 8);
  pseudo.writeUInt8(6, 9); // protocol TCP
  pseudo.writeUInt16BE(tcp.length, 10);
  tcp.writeUInt16BE(checksum(Buffer.concat([pseudo, tcp])), 16);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(20 + tcp.length, 2);
  ip.writeUInt16BE(0, 4); // identification
  ip.writeUInt16BE(0, 6); // flags + fragment offset
  ip.writeUInt8(64, 8); // TTL
  ip.writeUInt8(6, 9); // protocol TCP
  ip.writeUInt16BE(0, 10); // checksum filled below
  ip.writeUInt8(src[0]!, 12);
  ip.writeUInt8(src[1]!, 13);
  ip.writeUInt8(src[2]!, 14);
  ip.writeUInt8(src[3]!, 15);
  ip.writeUInt8(dst[0]!, 16);
  ip.writeUInt8(dst[1]!, 17);
  ip.writeUInt8(dst[2]!, 18);
  ip.writeUInt8(dst[3]!, 19);
  ip.writeUInt16BE(checksum(ip), 10);

  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(ETHERTYPE_IPV4, 12);

  return Buffer.concat([eth, ip, tcp]);
}

/** A frame plus its capture metadata, ready for PcapWriter. */
interface FixturePacket {
  bytes: Buffer;
  usec: number;
  capturedLength?: number;
}

function toCaptured(packet: FixturePacket): CapturedPacket {
  const capturedLength = packet.capturedLength ?? packet.bytes.length;
  return {
    bytes: packet.bytes,
    timestamp: Math.floor(packet.usec / 1_000),
    timestampUsec: packet.usec,
    capturedLength,
    originalLength: packet.bytes.length,
    linkType: 'LINKTYPE_ETHERNET',
  };
}

const SYN = 0x02;
const ACK = 0x10;
const PSH_ACK = 0x18;
const FIN_ACK = 0x11;
const RST = 0x04;
const RST_ACK = 0x14;

/** A standard three-way handshake with timestamps and window scaling. */
function handshake(startUsec: number, clientIsn: number, serverIsn: number): FixturePacket[] {
  return [
    {
      usec: startUsec,
      bytes: buildFrame({
        src: CLIENT, dst: SERVER, seq: clientIsn, flags: SYN,
        window: 65_535, mss: 1_460, wscale: 7, sackPermitted: true, tsVal: 1_000, tsEcr: 0,
      }),
    },
    {
      usec: startUsec + 20_000,
      bytes: buildFrame({
        src: SERVER, dst: CLIENT, seq: serverIsn, ack: clientIsn + 1, flags: SYN | ACK,
        window: 65_535, mss: 1_460, wscale: 7, sackPermitted: true, tsVal: 5_000, tsEcr: 1_000,
      }),
    },
    {
      usec: startUsec + 40_000,
      bytes: buildFrame({
        src: CLIENT, dst: SERVER, seq: clientIsn + 1, ack: serverIsn + 1, flags: ACK,
        window: 512, tsVal: 1_020, tsEcr: 5_000,
      }),
    },
  ];
}

// --- reset.pcap: a connection aborted by RST (the /api/reset behaviour) -----

function resetFixture(): FixturePacket[] {
  const packets = handshake(BASE_USEC, 1_000, 5_000);
  packets.push({
    usec: BASE_USEC + 60_000,
    bytes: buildFrame({
      src: CLIENT, dst: SERVER, seq: 1_001, ack: 5_001, flags: PSH_ACK,
      window: 512, tsVal: 1_040, tsEcr: 5_000, payload: Buffer.from('GET /api/reset HTTP/1.1\r\n\r\n'),
    }),
  });
  // Server aborts with RST+ACK instead of a normal response.
  packets.push({
    usec: BASE_USEC + 65_000,
    bytes: buildFrame({
      src: SERVER, dst: CLIENT, seq: 5_001, ack: 1_031, flags: RST_ACK, window: 0,
    }),
  });
  // A second attempt that is rejected outright with a bare RST.
  packets.push({
    usec: BASE_USEC + 100_000,
    bytes: buildFrame({ src: CLIENT, dst: SERVER, seq: 2_000, flags: SYN, window: 65_535, mss: 1_460 }),
  });
  packets.push({
    usec: BASE_USEC + 101_000,
    bytes: buildFrame({ src: SERVER, dst: CLIENT, seq: 0, ack: 2_001, flags: RST_ACK, window: 0 }),
  });
  return packets;
}

// --- retransmit.pcap: loss-induced retransmits, dup ACKs, out-of-order ------

function retransmitFixture(): FixturePacket[] {
  const packets = handshake(BASE_USEC, 10_000, 20_000);
  let usec = BASE_USEC + 60_000;
  const data = (seq: number, len: number, flags = PSH_ACK): FixturePacket => {
    const packet: FixturePacket = {
      usec,
      bytes: buildFrame({
        src: SERVER, dst: CLIENT, seq, ack: 10_001, flags, window: 512,
        tsVal: 5_000 + Math.floor((usec - BASE_USEC) / 1_000), tsEcr: 1_020,
        payload: Buffer.alloc(len, 0x61),
      }),
    };
    usec += 1_000;
    return packet;
  };
  const dupAck = (ack: number): FixturePacket => {
    const packet: FixturePacket = {
      usec,
      bytes: buildFrame({
        src: CLIENT, dst: SERVER, seq: 10_001, ack, flags: ACK, window: 512,
        tsVal: 1_020 + Math.floor((usec - BASE_USEC) / 1_000), tsEcr: 5_000,
      }),
    };
    usec += 1_000;
    return packet;
  };

  packets.push(data(20_001, 100)); // original segment
  packets.push(dupAck(20_001)); // three duplicate ACKs -> fast retransmit
  packets.push(dupAck(20_001));
  packets.push(dupAck(20_001));
  packets.push(data(20_001, 100)); // full retransmission of the same range
  packets.push(data(20_101, 200)); // next segment, 200 bytes
  packets.push(data(20_101, 100)); // partial retransmission (overlap, shorter)
  packets.push(data(20_401, 100)); // out-of-order: arrives before 20_301
  packets.push(data(20_301, 100)); // the gap fills in
  packets.push(dupAck(20_501)); // cumulative ACK advances past everything
  packets.push({
    usec,
    bytes: buildFrame({ src: SERVER, dst: CLIENT, seq: 20_501, ack: 10_001, flags: FIN_ACK, window: 512 }),
  });
  return packets;
}

// --- chunked.pcap: a response split across many PSH+ACK segments ------------

function chunkedFixture(): FixturePacket[] {
  const packets = handshake(BASE_USEC, 30_000, 40_000);
  let usec = BASE_USEC + 60_000;
  // Chunk sizes vary the way a chunked transfer-encoding response does.
  const chunkSizes = [120, 8, 256, 8, 64, 8, 512, 8, 32];
  let seq = 40_001;
  for (const size of chunkSizes) {
    packets.push({
      usec,
      bytes: buildFrame({
        src: SERVER, dst: CLIENT, seq, ack: 30_001, flags: PSH_ACK, window: 512,
        tsVal: 5_000 + Math.floor((usec - BASE_USEC) / 1_000), tsEcr: 1_020,
        payload: Buffer.alloc(size, 0x62),
      }),
    });
    seq += size;
    usec += 2_000;
    packets.push({
      usec,
      bytes: buildFrame({
        src: CLIENT, dst: SERVER, seq: 30_001, ack: seq, flags: ACK, window: 512,
        tsVal: 1_020 + Math.floor((usec - BASE_USEC) / 1_000), tsEcr: 5_000,
      }),
    });
    usec += 1_000;
  }
  packets.push({
    usec,
    bytes: buildFrame({ src: SERVER, dst: CLIENT, seq, ack: 30_001, flags: FIN_ACK, window: 512 }),
  });
  return packets;
}

// --- options.pcap: option variety, a truncated capture, and seq wrap --------

function optionsFixture(): FixturePacket[] {
  const packets: FixturePacket[] = [];
  let usec = BASE_USEC;
  const add = (spec: Omit<FrameSpec, 'src' | 'dst'> & { src?: Endpoint; dst?: Endpoint }): void => {
    packets.push({
      usec,
      bytes: buildFrame({ src: CLIENT, dst: SERVER, ...spec }),
      capturedLength: spec.capturedLength,
    });
    usec += 5_000;
  };

  // SYN carrying MSS + window scale + SACK permitted + timestamps.
  add({ seq: 0xffff_ff00, flags: SYN, window: 65_535, mss: 1_460, wscale: 7, sackPermitted: true, tsVal: 7_000, tsEcr: 0 });
  add({ src: SERVER, dst: CLIENT, seq: 0x8000_0000, ack: 0xffff_ff01, flags: SYN | ACK, window: 65_535, mss: 1_460, wscale: 7, sackPermitted: true, tsVal: 9_000, tsEcr: 7_000 });
  // ACK with a SACK block plus timestamps (sequence numbers near the wrap).
  add({ seq: 0xffff_ff01, ack: 0x8000_0001, flags: ACK, window: 512, sackBlocks: [[0x8000_0100, 0x8000_0200]], tsVal: 7_050, tsEcr: 9_000 });
  // A data segment whose payload is truncated in the capture (incl_len < orig_len).
  const full = buildFrame({
    src: SERVER, dst: CLIENT, seq: 0x8000_0001, ack: 0xffff_ff01, flags: PSH_ACK,
    window: 512, tsVal: 9_050, tsEcr: 7_050, payload: Buffer.alloc(200, 0x63),
  });
  packets.push({ usec, bytes: full, capturedLength: full.length - 200 }); // header only
  usec += 5_000;
  // Sequence numbers across the 2^32 wrap.
  add({ seq: 0xffff_ffff, ack: 0x8000_0001, flags: ACK, window: 512, tsVal: 7_100, tsEcr: 9_050 });
  add({ seq: 0x0000_0000, ack: 0x8000_0001, flags: PSH_ACK, window: 512, tsVal: 7_150, tsEcr: 9_050, payload: Buffer.from('wrap') });
  add({ src: SERVER, dst: CLIENT, seq: 0x8000_0001, ack: 0x0000_0005, flags: FIN_ACK, window: 512, tsVal: 9_100, tsEcr: 7_150 });
  add({ seq: 0x0000_0005, ack: 0x8000_0002, flags: RST, window: 0 });
  return packets;
}

async function writeFixture(name: string, packets: FixturePacket[]): Promise<void> {
  const path = join(OUT_DIR, `${name}.pcap`);
  const writer = new PcapWriter({ path, linkType: 1, log: () => {} });
  for (const packet of packets) writer.write(toCaptured(packet));
  await writer.close();
  console.log(`wrote ${packets.length} packets -> ${path}`);
}

mkdirSync(OUT_DIR, { recursive: true });
await writeFixture('reset', resetFixture());
await writeFixture('retransmit', retransmitFixture());
await writeFixture('chunked', chunkedFixture());
await writeFixture('options', optionsFixture());
console.log(`fixtures written to ${OUT_DIR}`);
