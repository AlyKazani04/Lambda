'use client';

import type { TcpMetadataEvent } from 'shared-types';

export default function TcpTable({ events }: { events: TcpMetadataEvent[] }) {
  return (
    <div>
      <h2>TCP ({events.length})</h2>
      <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th>time</th>
            <th>src</th>
            <th>dst</th>
            <th>flags</th>
            <th>seq</th>
            <th>ack</th>
            <th>window</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, index) => (
            <tr key={`tcp-${index}`}>
              <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
              <td>
                {event.src}:{event.srcPort}
              </td>
              <td>
                {event.dst}:{event.dstPort}
              </td>
              <td>{event.flags}</td>
              <td>{event.seq}</td>
              <td>{event.ack}</td>
              <td>{event.window}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
