'use client';

import type { FrameEvent } from 'shared-types';

export default function Frames({ frames }: { frames: FrameEvent[] }) {
  return (
    <div>
      <h2>Frames ({frames.length})</h2>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>trace</th>
            <th>hop</th>
            <th>method</th>
            <th>path</th>
            <th>status</th>
            <th>req/resp bytes</th>
            <th>duration</th>
            <th>internal</th>
            <th>tls</th>
            <th>sni</th>
            <th>headers</th>
          </tr>
        </thead>
        <tbody>
          {frames.map((frame, index) => (
            <tr key={`${frame.traceId}-${index}`}>
              <td>{frame.traceId}</td>
              <td>{frame.hop}</td>
              <td>{frame.method}</td>
              <td>{frame.path}</td>
              <td>{frame.status}</td>
              <td>
                {frame.requestBytes}/{frame.responseBytes}
              </td>
              <td>{frame.durationMs.toFixed(1)} ms</td>
              <td>{frame.internalMs.toFixed(2)} ms</td>
              <td>{frame.tlsMode ?? '-'}</td>
              <td>{frame.sni ?? '-'}</td>
              <td>
                {frame.headers === undefined ? '-' : (
                  <details>
                    <summary>{Object.keys(frame.headers).length}</summary>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                      {Object.entries(frame.headers)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join('\n')}
                    </pre>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
