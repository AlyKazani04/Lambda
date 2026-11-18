#!/usr/bin/env -S node --import tsx
// B9 self-test: write a large, structurally valid capture with the same
// PcapWriter the proxy uses. No privileges and no network are needed.
//
//   node --import tsx tools/pcap-selftest.ts /tmp/selftest.pcap 10000
//   tools/pcap-verify.sh /tmp/selftest.pcap
//
// The output is deliberately ordinary Ethernet/IPv4/TCP so tshark and
// Wireshark dissect it exactly as they would a real export.

import { PcapWriter } from '../apps/proxy/src/l4/pcap-writer.js';
import type { CapturedPacket } from '../apps/proxy/src/l4/capture.js';

const path = process.argv[2] ?? '/tmp/lambda-selftest.pcap';
const count = Number(process.argv[3] ?? '10_000');

if (!Number.isInteger(count) || count <= 0) {
  throw new Error(`packet count must be a positive integer, got ${JSON.stringify(process.argv[3])}`);
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < header.length; offset += 2) {
    sum += header.readUInt16BE(offset);
  }
  while ((sum >> 16) !== 0) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function frame(index: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(index + 1, 0);

  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(51_000 + (index % 100), 0);
  tcp.writeUInt16BE(8080, 2);
  tcp.writeUInt32BE(index + 1, 4);
  tcp.writeUInt32BE(0, 8);
  tcp.writeUInt16BE(0x5000, 12);
  tcp.writeUInt8(index % 3 === 0 ? 0x02 : 0x10, 13); // SYN or ACK
  tcp.writeUInt16BE(65_535, 14);
  tcp.writeUInt16BE(0, 16);
  tcp.writeUInt16BE(0, 18);

  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt8(0, 1);
  ip.writeUInt16BE(20 + tcp.length + payload.length, 2);
  ip.writeUInt16BE(index & 0xffff, 4);
  ip.writeUInt16BE(0, 6);
  ip.writeUInt8(64, 8);
  ip.writeUInt8(6, 9);
  ip.writeUInt16BE(0, 10);
  ip.writeUInt32BE(0xc0a8_010a, 12); // 192.168.1.10
  ip.writeUInt32BE(0xc0a8_0114, 16); // 192.168.1.20
  ip.writeUInt16BE(checksum(ip), 10);

  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);

  return Buffer.concat([eth, ip, tcp, payload]);
}

const writer = new PcapWriter({ path, linkType: 1 });
const baseUsec = 1_700_000_000_000_000;
for (let i = 0; i < count; i += 1) {
  const timestampUsec = baseUsec + i * 1_000 + (i % 1_000);
  const bytes = frame(i);
  const packet: CapturedPacket = {
    bytes,
    timestamp: Math.floor(timestampUsec / 1_000),
    timestampUsec,
    capturedLength: bytes.length,
    originalLength: bytes.length,
    linkType: 'LINKTYPE_ETHERNET',
  };
  writer.write(packet);
}
await writer.close();
console.log(`wrote ${count} packets to ${path}`);
