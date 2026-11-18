import { NextResponse } from 'next/server';

import { proxyExportUrl, safeDownloadFilename } from '../../../lib/export';

export const dynamic = 'force-dynamic';

function fallbackFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `lambda-capture-${stamp}.pcap`;
}

/** Stream the proxy's current capture to the browser as a file download. */
export async function GET() {
  const url = `${proxyExportUrl()}/api/export.pcap`;
  try {
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!upstream.ok) {
      let detail: unknown;
      try {
        detail = await upstream.json();
      } catch {
        detail = await upstream.text().catch(() => '');
      }
      return NextResponse.json(
        { error: 'proxy_export_failed', status: upstream.status, detail },
        { status: 502 },
      );
    }

    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const filename =
      safeDownloadFilename(upstream.headers.get('content-disposition')) ?? fallbackFilename();

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.tcpdump.pcap',
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'proxy_unreachable',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
