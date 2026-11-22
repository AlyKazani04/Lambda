'use client';

import type { TcpStateEvent } from 'shared-types';

function latestByConnection(events: TcpStateEvent[]): Map<string, Map<string, TcpStateEvent>> {
  const byConnection = new Map<string, Map<string, TcpStateEvent>>();
  for (const event of events) {
    let sides = byConnection.get(event.connectionId);
    if (sides === undefined) {
      sides = new Map();
      byConnection.set(event.connectionId, sides);
    }
    sides.set(event.side, event);
  }
  return byConnection;
}

export default function Connections({ events }: { events: TcpStateEvent[] }) {
  const current = latestByConnection(events);
  const rows = [...current.values()].flatMap((sides) => [...sides.values()]);
  const showIllegal = events.some((event) => event.illegal === true);

  return (
    <div>
      <h2>Connections ({current.size})</h2>
      <h3>Current state</h3>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>connection</th>
            <th>side</th>
            <th>state</th>
            <th>RSTs</th>
            <th>trace</th>
            <th>changed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((event, index) => (
            <tr key={`c-${index}`}>
              <td>{event.connectionId}</td>
              <td>{event.side}</td>
              <td>{event.state}</td>
              <td>{event.rstCount}</td>
              <td>{event.path ?? (event.traceId ?? '-')}</td>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>History</h3>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>connection</th>
            <th>side</th>
            <th>state</th>
            <th>trace</th>
            {showIllegal && <th>flags</th>}
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`h-${index}`}>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
              <td>{event.connectionId}</td>
              <td>{event.side}</td>
              <td>{event.state}</td>
              <td>{event.path ?? (event.traceId ?? '-')}</td>
              {showIllegal && <td>{event.illegal === true ? 'illegal' : '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
