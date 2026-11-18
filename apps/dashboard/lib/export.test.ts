// Tests for the B9 dashboard export proxy. The route is exercised against a
// real local HTTP server standing in for the proxy, so the download bytes and
// headers are checked as a browser would see them.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { proxyExportUrl, safeDownloadFilename } from './export.js';
import { GET } from '../app/api/export/route.js';

const originalProxyExportUrl = process.env.PROXY_EXPORT_URL;
after(() => {
  if (originalProxyExportUrl === undefined) {
    delete process.env.PROXY_EXPORT_URL;
  } else {
    process.env.PROXY_EXPORT_URL = originalProxyExportUrl;
  }
});

test('proxyExportUrl defaults to the local proxy and trims trailing slashes', () => {
  assert.equal(proxyExportUrl({}), 'http://127.0.0.1:8080');
  assert.equal(proxyExportUrl({ PROXY_EXPORT_URL: 'http://proxy:8080///' }), 'http://proxy:8080');
  assert.equal(proxyExportUrl({ PROXY_EXPORT_URL: '  ' }), 'http://127.0.0.1:8080');
});

test('safeDownloadFilename accepts a plain pcap name and rejects path tricks', () => {
  assert.equal(
    safeDownloadFilename('attachment; filename="lambda-capture-2026-01-01.pcap"'),
    'lambda-capture-2026-01-01.pcap',
  );
  assert.equal(safeDownloadFilename('attachment; filename="../etc/passwd"'), null);
  assert.equal(safeDownloadFilename('attachment; filename="a.pcap"; x="evil"'), null);
  assert.equal(safeDownloadFilename(null), null);
});

async function withProxy(run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/export.pcap') {
      const body = Buffer.from([0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3, 4]);
      res.writeHead(200, {
        'content-type': 'application/vnd.tcpdump.pcap',
        'content-disposition': 'attachment; filename="capture.pcap"',
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
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

test('GET streams the capture from the proxy with a safe download filename', async () => {
  await withProxy(async (url) => {
    process.env.PROXY_EXPORT_URL = url;
    const response = await GET();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/vnd.tcpdump.pcap');
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="capture.pcap"',
    );
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.readUInt32LE(0), 0xa1b2c3d4);
  });
});

test('GET returns 502 when the proxy cannot be reached', async () => {
  process.env.PROXY_EXPORT_URL = 'http://127.0.0.1:1';
  const response = await GET();
  assert.equal(response.status, 502);
  const body = await response.json() as { error: string; detail: string };
  assert.equal(body.error, 'proxy_unreachable');
  assert.equal(body.detail, 'the proxy could not be reached');
  assert.doesNotMatch(body.detail, /ECONNREFUSED|127\.0\.0\.1:1/);
});
