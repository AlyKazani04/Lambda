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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
