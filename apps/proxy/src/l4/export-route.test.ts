// End-to-end tests for the B9 export endpoint: a real HTTP server, a real
// PcapRecorder, and a real fetch. No mocks — the response body is the file
// Wireshark would open.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AddressInfo } from 'node:net';
import type { CapturedPacket } from './capture.js';
import { PcapRecorder } from './pcap-recorder.js';
import { handleExportRequest } from './export-route.js';

const bytes = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

function packet(marker: number): CapturedPacket {
  return {
    bytes,
    timestamp: 1_700_000_000_000,
    timestampUsec: 1_700_000_000_000_000 + marker,
    capturedLength: bytes.length,
    originalLength: bytes.length,
    linkType: 'LINKTYPE_ETHERNET',
  };
}

async function withServer(
  recorder: PcapRecorder | null,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => handleExportRequest(req, res, recorder));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('GET /api/export.pcap streams a complete pcap with a download filename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lambda-export-route-'));
  const recorder = new PcapRecorder({ path: join(dir, 'capture.pcap'), log: () => {} });
  recorder.observe(packet(1));
  recorder.observe(packet(2));

  await withServer(recorder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export.pcap`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.tcpdump.pcap');
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="lambda-capture-.*\.pcap"$/);

    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.readUInt32LE(0), 0xa1b2c3d4);
    assert.equal(body.length, 24 + 2 * (16 + bytes.length));
    assert.equal(body.readUInt32LE(body.length - 4), 0xddccbbaa);
  });

  await recorder.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/export.pcap reports 503 before any packet is captured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lambda-export-route-'));
  const recorder = new PcapRecorder({ path: join(dir, 'capture.pcap'), log: () => {} });

  await withServer(recorder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export.pcap`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'capture_not_ready',
      detail: 'no packets captured yet — generate traffic, then retry',
    });
  });

  await recorder.close();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /api/export.pcap reports 503 when capture writing is disabled', async () => {
  await withServer(null, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export.pcap`);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, 'capture_disabled');
  });
});

test('POST /api/export.pcap is rejected with 405', async () => {
  await withServer(null, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export.pcap`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });
});

test('a failed export never returns the underlying error message', async () => {
  // A directory is not a file: readFile throws EISDIR, which would otherwise
  // leak the absolute path through the 500 response (CWE-209).
  const dir = mkdtempSync(join(tmpdir(), 'lambda-export-error-'));
  const recorder = new PcapRecorder({ path: dir, log: () => {} });
  recorder.observe(packet(1));

  await withServer(recorder, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/export.pcap`);
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string; detail: string };
    assert.equal(body.error, 'export_failed');
    assert.equal(body.detail, 'capture export failed; see proxy log');
    assert.doesNotMatch(body.detail, /EISDIR|ENOENT|lambda-export-error/);
  });

  await recorder.close();
  rmSync(dir, { recursive: true, force: true });
});
