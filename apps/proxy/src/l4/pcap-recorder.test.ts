// Unit tests for the B9 export recorder. A snapshot must hand out a complete
// .pcap to the caller while the live capture keeps writing into a fresh file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CapturedPacket } from './capture.js';
import { PcapRecorder } from './pcap-recorder.js';

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lambda-recorder-'));
  return join(dir, 'capture.pcap');
}

function packet(marker: number): CapturedPacket {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(marker, 0);
  return {
    bytes,
    timestamp: 1_700_000_000_000,
    timestampUsec: 1_700_000_000_000_000 + marker,
    capturedLength: 4,
    originalLength: 4,
    linkType: 'LINKTYPE_ETHERNET',
  };
}

function recordCount(file: Buffer): number {
  let offset = 24;
  let count = 0;
  while (offset < file.length) {
    const inclLen = file.readUInt32LE(offset + 8);
    offset += 16 + inclLen;
    count += 1;
  }
  return count;
}

test('snapshot returns a complete pcap and capture continues into a fresh file', async () => {
  const path = tempPath();
  const recorder = new PcapRecorder({ path, log: () => {} });

  recorder.observe(packet(1));
  recorder.observe(packet(2));
  const first = await recorder.snapshot();
  assert.ok(first !== null);
  assert.equal(first.readUInt32LE(0), 0xa1b2c3d4);
  assert.equal(recordCount(first), 2);
  assert.equal(first.readUInt32BE(24 + 16), 1);
  assert.equal(first.readUInt32BE(24 + 16 + (16 + 4)), 2);

  recorder.observe(packet(3));
  const second = await recorder.snapshot();
  assert.ok(second !== null);
  assert.equal(recordCount(second), 1);
  assert.equal(second.readUInt32BE(24 + 16), 3);

  await recorder.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('snapshot before any packet returns null', async () => {
  const path = tempPath();
  const recorder = new PcapRecorder({ path, log: () => {} });

  assert.equal(await recorder.snapshot(), null);

  await recorder.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('a snapshot with no packets since the last one still returns a valid empty pcap', async () => {
  const path = tempPath();
  const recorder = new PcapRecorder({ path, log: () => {} });

  recorder.observe(packet(7));
  await recorder.snapshot();
  const empty = await recorder.snapshot();

  assert.ok(empty !== null);
  assert.equal(empty.length, 24);
  assert.equal(recordCount(empty), 0);

  await recorder.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});

test('concurrent snapshots both return non-null valid pcaps', async () => {
  const path = tempPath();
  const recorder = new PcapRecorder({ path, log: () => {} });

  for (let i = 1; i <= 5; i += 1) recorder.observe(packet(i));

  const [first, second] = await Promise.all([
    recorder.snapshot(),
    recorder.snapshot(),
  ]);

  assert.ok(first !== null, 'first snapshot must be non-null');
  assert.ok(second !== null, 'second snapshot must be non-null');
  assert.equal(first.readUInt32LE(0), 0xa1b2c3d4);
  assert.equal(second.readUInt32LE(0), 0xa1b2c3d4);
  assert.equal(recordCount(first), 5);
  // The second snapshot is serialized after the first, so no packets have
  // arrived since it: a valid empty pcap, never null (which caused a 503).
  assert.equal(recordCount(second), 0);

  await recorder.close();
  rmSync(join(path, '..'), { recursive: true, force: true });
});
