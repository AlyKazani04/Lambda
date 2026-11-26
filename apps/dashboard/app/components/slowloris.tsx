'use client';

import type { SlowlorisEvent } from 'shared-types';

export default function Slowloris({ events }: { events: SlowlorisEvent[] }) {
  return (
    <div>
      <h2>Slowloris ({events.length})</h2>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>phase</th>
            <th>reason</th>
            <th>client</th>
            <th>idle</th>
            <th>bytes</th>
            <th>trace</th>
            <th>path</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.timestamp}-${index}`}>
              <td>{new Date(event.timestamp).toISOString().slice(11, 23)}</td>
              <td>{event.phase}</td>
              <td>{event.reason}</td>
              <td>{event.client}</td>
              <td>{event.elapsedMs.toFixed(0)} ms</td>
              <td>{event.bytesReceived}</td>
              <td>{event.traceId ?? '-'}</td>
              <td>{event.path ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
