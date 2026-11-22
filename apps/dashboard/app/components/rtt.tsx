'use client';

import type { RttEstimateEvent } from 'shared-types';

function latestByConnection(events: RttEstimateEvent[]): Map<string, RttEstimateEvent> {
  const latest = new Map<string, RttEstimateEvent>();
  for (const event of events) latest.set(event.connectionId, event);
  return latest;
}

function millis(value: number | null): string {
  return value === null ? '-' : value.toFixed(2);
}

export default function Rtt({ events }: { events: RttEstimateEvent[] }) {
  const latest = [...latestByConnection(events).values()];
  const samples = events.filter((event) => event.sample !== undefined);

  return (
    <div>
      <h2>RTT estimates ({latest.length})</h2>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>connection</th>
            <th>SRTT ms</th>
            <th>RTTVAR ms</th>
            <th>base RTO ms</th>
            <th>timer ms</th>
            <th>state</th>
            <th>updated</th>
          </tr>
        </thead>
        <tbody>
          {latest.map((event) => (
            <tr key={event.connectionId}>
              <td>{event.connectionId}</td>
              <td>{millis(event.srttMs)}</td>
              <td>{millis(event.rttvarMs)}</td>
              <td>{millis(event.baseRtoMs)}</td>
              <td>{millis(event.rtoMs)}</td>
              <td>{event.backedOff ? 'backed off' : event.kind}</td>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Raw samples ({samples.length})</h3>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>connection</th>
            <th>from</th>
            <th>method</th>
            <th>sample ms</th>
            <th>SRTT ms</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((event, index) => (
            <tr key={`s-${index}`}>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
              <td>{event.connectionId}</td>
              <td>{event.sample?.from}</td>
              <td>{event.sample?.method}</td>
              <td>{millis(event.sample?.rttMs ?? null)}</td>
              <td>{millis(event.srttMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
