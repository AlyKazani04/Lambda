'use client';

import { useState } from 'react';

type Status = 'idle' | 'working' | 'done' | 'error';

export default function ExportPage() {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  async function download(): Promise<void> {
    setStatus('working');
    setMessage('Reading the live capture from the proxy...');
    try {
      const response = await fetch('/api/export', { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as {
          error?: string;
          detail?: unknown;
        } | null;
        const detail = body?.detail === undefined ? '' : `: ${String(body.detail)}`;
        throw new Error(`${body?.error ?? `HTTP ${response.status}`}${detail}`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'lambda-capture.pcap';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoking immediately can cancel the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);

      setStatus('done');
      setMessage(
        `Downloaded ${(blob.size / 1024).toFixed(1)} KiB as ${filename}. ` +
        'Open it in Wireshark and filter on tcp.flags.reset == 1 to find the RST caused by /api/reset.',
      );
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720 }}>
      <p style={{ fontSize: '0.85rem', color: '#666' }}>
        <a href="/">← Back to dashboard</a>
      </p>
      <h1 style={{ fontSize: '1.4rem' }}>Export capture (.pcap)</h1>
      <p style={{ lineHeight: 1.6 }}>
        Write a file from our own capture and open it in Wireshark. The download is a
        snapshot of everything captured so far; the proxy keeps capturing into a new
        file afterwards.
      </p>
      <button
        type="button"
        onClick={() => void download()}
        disabled={status === 'working'}
        style={{
          padding: '0.6rem 1rem',
          background: status === 'working' ? '#888' : '#1f6feb',
          color: '#fff',
          border: 0,
          borderRadius: 4,
          cursor: status === 'working' ? 'not-allowed' : 'pointer',
        }}
      >
        {status === 'working' ? 'Preparing download...' : 'Download .pcap'}
      </button>
      {message !== '' && (
        <p
          role="status"
          style={{
            marginTop: '1rem',
            padding: '0.75rem',
            border: '1px solid #ddd',
            borderRadius: 4,
            background: status === 'error' ? '#fff3f3' : '#f6f8fa',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>
      )}
      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: '#666' }}>
        Capture must be enabled (CAPTURE_IFACE) and at least one packet must have been
        seen. Generate traffic through the proxy first if the button reports that
        the capture is not ready.
      </p>
    </div>
  );
}
