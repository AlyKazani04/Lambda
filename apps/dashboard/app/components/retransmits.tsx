'use client';

import type { RetransmitEvent } from 'shared-types';

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function millis(value: number | null): string {
  return value === null ? '-' : value.toFixed(1);
}

export default function Retransmits({ events }: { events: RetransmitEvent[] }) {
  const globalRate = events[0]?.globalRate ?? 0;

  return (
    <div>
      <h2>Retransmissions ({events.length}) · rate at last event {percent(globalRate)}</h2>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>connection</th>
            <th>from</th>
            <th>kind</th>
            <th>cause</th>
            <th>seq</th>
            <th>bytes</th>
            <th>overlap</th>
            <th>delay ms</th>
            <th>observed RTO ms</th>
            <th>dup ACKs</th>
            <th>rate</th>
            <th>flags</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`r-${index}`}>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
              <td>{event.connectionId}</td>
              <td>{event.from}</td>
              <td>{event.kind}</td>
              <td>{event.cause}</td>
              <td>{event.seq}</td>
              <td>{event.length}</td>
              <td>{event.overlapBytes}</td>
              <td>{millis(event.delayMs)}</td>
              <td>{millis(event.observedRtoMs)}</td>
              <td>{event.dupAcks}</td>
              <td>{percent(event.rate)}</td>
              <td>{event.truncated ? 'truncated' : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
