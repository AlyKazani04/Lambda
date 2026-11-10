'use client';

import { useEffect, useState } from 'react';

import type { FrameEvent, TcpMetadataEvent } from 'shared-types';

interface StreamMessage {
  channel: string;
  payload: unknown;
}

const MAX_ROWS = 200;

export default function Home() {
  const [frames, setFrames] = useState<FrameEvent[]>([]);
  const [tcpEvents, setTcpEvents] = useState<TcpMetadataEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event: MessageEvent<string>) => {
      let message: StreamMessage;
      try {
        message = JSON.parse(event.data) as StreamMessage;
      } catch {
        return;
      }
      if (message.channel === 'frames') {
        setFrames((prev) => [message.payload as FrameEvent, ...prev].slice(0, MAX_ROWS));
      } else if (message.channel === 'tcp') {
        setTcpEvents((prev) => [message.payload as TcpMetadataEvent, ...prev].slice(0, MAX_ROWS));
      }
    };

    return () => ws.close();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>
      <h1>Lambda</h1>
      <p>WebSocket: {connected ? 'connected' : 'disconnected'}</p>

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

      <h2>TCP ({tcpEvents.length})</h2>
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
          {tcpEvents.map((event, index) => (
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
    </main>
  );
}
