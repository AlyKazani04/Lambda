'use client';

import type { SniRouteEvent } from 'shared-types';

export default function SniRoutes({ events }: { events: SniRouteEvent[] }) {
  return (
    <div>
      <h2>SNI routes ({events.length})</h2>
      <p style={{ fontSize: '0.8rem', color: '#666' }}>
        Passthrough rows carry no method, path or headers: the proxy routed on SNI without decrypting.
      </p>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>host</th>
            <th>mode</th>
            <th>upstream</th>
            <th>bytes</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`${event.timestamp}-${index}`}>
              <td>{new Date(event.timestamp).toISOString().slice(11, 23)}</td>
              <td>{event.host}</td>
              <td>{event.mode}</td>
              <td>{event.upstream}</td>
              <td>{event.requestBytes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
