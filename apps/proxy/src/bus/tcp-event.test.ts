// Unit tests for the proxy → dashboard TCP metadata mapping.
//
// These are pure functions over a synthetic ParsedPacket: no capture, no
// privileges, no Redis. The point is to pin the published payload shape that
// the dashboard consumes, so a change here cannot silently break the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ParsedPacket, TcpFlags } from 'shared-types';

import { formatTcpFlags, toTcpMetadataEvent } from './tcp-event.js';

function makeFlags(overrides: Partial<TcpFlags> = {}): TcpFlags {
  return {
    fin: false,
    syn: false,
    rst: false,
    psh: false,
    ack: false,
    urg: false,
    ece: false,
    cwr: false,
    ns: false,
    raw: 0,
    ...overrides,
  };
}

function makePacket(overrides: Partial<ParsedPacket> = {}): ParsedPacket {
  return {
    timestamp: 1_700_000_000_000,
    capturedLength: 54,
    originalLength: 54,
    linkType: 1,
    ethernet: { dstMac: '00:00:00:00:00:00', srcMac: '00:00:00:00:00:00', etherType: 0x0800 },
    ipv4: {
      version: 4,
      ihl: 5,
      totalLength: 40,
      identification: 0,
      flags: 0,
      fragmentOffset: 0,
      ttl: 64,
      protocol: 6,
      srcIp: '192.168.1.10',
      dstIp: '192.168.1.20',
    },
    tcp: {
      srcPort: 51_000,
      dstPort: 8080,
      seq: 100,
      ack: 0,
      dataOffset: 5,
      flags: makeFlags({ syn: true }),
      window: 64_240,
      checksum: 0,
      urgentPointer: 0,
      options: {
        sackPermitted: false,
        sackBlocks: [],
        unknown: [],
        mss: 1460,
        windowScale: 7,
        timestamps: { tsVal: 11, tsEcr: 22 },
      },
    },
    payload: new Uint8Array(0),
    fiveTuple: {
      srcIp: '192.168.1.10',
      srcPort: 51_000,
      dstIp: '192.168.1.20',
      dstPort: 8080,
      protocol: 6,
    },
    ...overrides,
  };
}

test('formats flags in wire order and handles the no-flag case', () => {
  assert.equal(formatTcpFlags(makeFlags({ syn: true, ack: true })), 'SYN,ACK');
  assert.equal(formatTcpFlags(makeFlags({ fin: true, ack: true })), 'FIN,ACK');
  assert.equal(formatTcpFlags(makeFlags()), '-');
});

test('maps a parsed packet onto the shared TCP metadata contract', () => {
  const event = toTcpMetadataEvent(makePacket());

  assert.equal(event.timestamp, 1_700_000_000_000);
  assert.equal(event.src, '192.168.1.10');
  assert.equal(event.dst, '192.168.1.20');
  assert.equal(event.srcPort, 51_000);
  assert.equal(event.dstPort, 8080);
  assert.equal(event.flags, 'SYN');
  assert.equal(event.seq, 100);
  assert.equal(event.ack, 0);
  assert.equal(event.window, 64_240);
  assert.deepEqual(event.options, {
    windowScale: 7,
    mss: 1460,
    sackPermitted: false,
    sackBlocks: [],
    timestamps: { tsVal: 11, tsEcr: 22 },
  });
});

test('a mapped event is JSON-serialisable for the Redis bridge', () => {
  const json = JSON.stringify(toTcpMetadataEvent(makePacket()));
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed['channel'] ?? parsed['flags'], 'SYN');
  assert.equal(typeof parsed['timestamp'], 'number');
});
