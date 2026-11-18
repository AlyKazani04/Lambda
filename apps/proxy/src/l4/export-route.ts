// B9: HTTP contract for the .pcap export endpoint. Kept separate from the
// proxy bootstrap so the byte-level response is testable with a real server.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PcapRecorder } from './pcap-recorder.js';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Filename is derived only from the clock — no request input reaches it. */
export function pcapFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `lambda-capture-${stamp}.pcap`;
}

export async function servePcapExport(
  res: ServerResponse,
  recorder: PcapRecorder | null,
): Promise<void> {
  if (recorder === null) {
    sendJson(res, 503, {
      error: 'capture_disabled',
      detail: 'PCAP_EXPORT_PATH is empty; no pcap is being written',
    });
    return;
  }
  try {
    const bytes = await recorder.snapshot();
    if (bytes === null) {
      sendJson(res, 503, {
        error: 'capture_not_ready',
        detail: 'no packets captured yet — generate traffic, then retry',
      });
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.tcpdump.pcap',
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${pcapFilename()}"`,
      'cache-control': 'no-store',
    });
    res.end(bytes);
  } catch (error) {
    sendJson(res, 500, {
      error: 'export_failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleExportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  recorder: PcapRecorder | null,
): void {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }
  void servePcapExport(res, recorder);
}
