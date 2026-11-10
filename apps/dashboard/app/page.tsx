'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import type { FrameEvent, TcpMetadataEvent } from 'shared-types';

import Frames from './components/frames';
import Overview from './components/overview';
import ServiceDetail from './components/service-detail';
import TcpTable from './components/tcp';

interface StreamMessage {
  channel: string;
  payload: unknown;
}

const MAX_ROWS = 200;

type BuiltinView = 'overview' | 'frames' | 'tcp';

function sidebarButtonStyle(active: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '0.4rem 0.6rem',
    marginBottom: '0.25rem',
    border: '1px solid transparent',
    borderRadius: 4,
    background: active ? '#1f6feb' : 'transparent',
    color: active ? '#fff' : '#333',
    cursor: 'pointer',
  };
}

export default function Home() {
  const [view, setView] = useState<string>('overview');
  const [serviceNames, setServiceNames] = useState<string[]>([]);
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

  useEffect(() => {
    void fetch('/api/services')
      .then((res) => res.json())
      .then((data: { services: Array<{ name: string }> }) => {
        setServiceNames(data.services.map((service) => service.name));
      })
      .catch(() => {});
  }, []);

  const builtins: Array<{ id: BuiltinView; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'frames', label: 'Frames' },
    { id: 'tcp', label: 'TCP' },
  ];

  const activeService = view === 'overview' || view === 'frames' || view === 'tcp' ? null : view;

  return (
    <div style={{ display: 'flex', fontFamily: 'system-ui, sans-serif' }}>
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: '1px solid #ddd',
          padding: '1rem',
          minHeight: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ fontSize: '1.2rem', margin: '0 0 1rem' }}>Lambda</h1>
        <nav>
          {builtins.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setView(entry.id)}
              style={sidebarButtonStyle(view === entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <h2
          style={{
            fontSize: '0.8rem',
            textTransform: 'uppercase',
            color: '#666',
            margin: '1.5rem 0 0.5rem',
          }}
        >
          Services
        </h2>
        <nav>
          {serviceNames.map((name) => (
            <button key={name} onClick={() => setView(name)} style={sidebarButtonStyle(view === name)}>
              {name}
            </button>
          ))}
        </nav>
        <p style={{ fontSize: '0.75rem', color: '#666', marginTop: '1rem' }}>
          WebSocket: {connected ? 'connected' : 'disconnected'}
        </p>
      </aside>

      <main style={{ flex: 1, padding: '1.5rem', overflow: 'auto' }}>
        {view === 'overview' && <Overview />}
        {view === 'frames' && <Frames frames={frames} />}
        {view === 'tcp' && <TcpTable events={tcpEvents} />}
        {activeService !== null && <ServiceDetail name={activeService} />}
      </main>
    </div>
  );
}
