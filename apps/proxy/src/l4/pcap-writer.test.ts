// Unit tests for the B9 .pcap export path.
//
// These are pure filesystem tests over synthetic packets: no capture device,
// no privileges, no network. They read the bytes the writer produced so the
// assertions describe what Wireshark will actually see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CapturedPacket } from './capture.js';
import { createPcapWriter, linkTypeToPcap } from './pcap-writer.js';

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lambda-pcap-'));
  return join(dir, name);
}

function packet(overrides: Partial<CapturedPacket> = {}): CapturedPacket {
  return {
    bytes: Buffer.from([1, 2, 3, 4]),
    // capture.ts emits whole milliseconds in `timestamp`; the exact capture
    // microseconds travel separately so the file keeps full precision.
    timestamp: 1_700_000_000_123,
    timestampUsec: 1_700_000_000_123_456,
    capturedLength: 4,
    originalLength: 4,
    linkType: 'LINKTYPE_ETHERNET',
    ...overrides,
  };
}

test('writes the capture microsecond timestamp, not a millisecond-rounded one', async () => {
  const path = tempPath('timestamp.pcap');
  const writer = createPcapWriter({ path, log: () => {} });
  writer.write(packet());
  await writer.close();

  const file = readFileSync(path);
  assert.equal(file.length, 24 + 16 + 4);
  assert.equal(file.readUInt32LE(24), 1_700_000_000);
  assert.equal(file.readUInt32LE(28), 123_456);

  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('maps every capture link type to its pcap link-layer header value', () => {
  assert.equal(linkTypeToPcap('LINKTYPE_NULL'), 0);
  assert.equal(linkTypeToPcap('LINKTYPE_ETHERNET'), 1);
  assert.equal(linkTypeToPcap('LINKTYPE_RAW'), 101);
  assert.equal(linkTypeToPcap('LINKTYPE_LINUX_SLL'), 113);
  // Radiotap: the WiFi NIC in this project. Mapping it to Ethernet (1) makes
  // Wireshark dissect every frame as the wrong link layer.
  assert.equal(linkTypeToPcap('LINKTYPE_IEEE802_11_RADIO'), 127);
});

test('writes the captured link type into the global header', async () => {
  const path = tempPath('linktype.pcap');
  const writer = createPcapWriter({
    path,
    linkType: linkTypeToPcap('LINKTYPE_IEEE802_11_RADIO'),
    log: () => {},
  });
  writer.write(packet({ linkType: 'LINKTYPE_IEEE802_11_RADIO' }));
  await writer.close();

  assert.equal(readFileSync(path).readUInt32LE(20), 127);

  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('clamps captured length to snaplen but keeps the on-wire length', async () => {
  const path = tempPath('snaplen.pcap');
  const writer = createPcapWriter({ path, snaplen: 8, log: () => {} });
  writer.write(packet({
    bytes: Buffer.alloc(20, 0xab),
    capturedLength: 20,
    originalLength: 20,
  }));
  await writer.close();

  const file = readFileSync(path);
  assert.equal(file.readUInt32LE(16), 8);
  assert.equal(file.readUInt32LE(32), 8); // incl_len of the first record
  assert.equal(file.readUInt32LE(36), 20); // orig_len of the first record
  assert.equal(file.length, 24 + 16 + 8);

  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('writes 10,000 packets as 10,000 complete records', async () => {
  const path = tempPath('10k.pcap');
  const payload = Buffer.alloc(14, 0xcd);
  const writer = createPcapWriter({ path, log: () => {} });
  for (let i = 0; i < 10_000; i += 1) {
    writer.write(packet({ bytes: payload, capturedLength: 14, originalLength: 14 }));
  }
  await writer.close();

  const file = readFileSync(path);
  assert.equal(file.length, 24 + 10_000 * (16 + 14));
  let offset = 24;
  let records = 0;
  while (offset < file.length) {
    assert.equal(file.readUInt32LE(offset + 8), 14);
    offset += 16 + 14;
    records += 1;
  }
  assert.equal(records, 10_000);

  rmSync(join(path, '..'), { recursive: true, force: true });
});
