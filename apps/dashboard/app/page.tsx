'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import type { FrameEvent, RetransmitEvent, RttEstimateEvent, TcpMetadataEvent, TcpStateEvent } from 'shared-types';

import { parseFrameEvent, parseRetransmitEvent, parseRttEvent, parseTcpEvent, parseTcpStateEvent } from '../lib/stream';
import { useServices } from '../lib/use-services';

import Frames from './components/frames';
import Connections from './components/connections';
import Rtt from './components/rtt';
import Retransmits from './components/retransmits';
import Overview from './components/overview';
import ServiceDetail from './components/service-detail';
import TcpTable from './components/tcp';

interface StreamMessage {
  channel: string;
  payload: unknown;
}

const MAX_ROWS = 200;

type BuiltinView = 'overview' | 'frames' | 'tcp' | 'connections' | 'rtt' | 'retransmits';

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
  const services = useServices();
  const serviceNames = services.map((service) => service.name);
  const [frames, setFrames] = useState<FrameEvent[]>([]);
  const [tcpEvents, setTcpEvents] = useState<TcpMetadataEvent[]>([]);
  const [stateEvents, setStateEvents] = useState<TcpStateEvent[]>([]);
  const [rttEvents, setRttEvents] = useState<RttEstimateEvent[]>([]);
  const [retransmitEvents, setRetransmitEvents] = useState<RetransmitEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      // A skewed proxy can send `null`, an array or a message without a
      // channel. Reject those before touching properties, and let the payload
      // validators below reject malformed frame/TCP rows individually.
      if (typeof parsed !== 'object' || parsed === null) return;
      const message = parsed as StreamMessage;
      if (typeof message.channel !== 'string') return;
      if (message.channel === 'frames') {
        const frame = parseFrameEvent(message.payload);
        if (frame === null) return;
        setFrames((prev) => [frame, ...prev].slice(0, MAX_ROWS));
      } else if (message.channel === 'tcp') {
        const event = parseTcpEvent(message.payload);
        if (event === null) return;
        setTcpEvents((prev) => [event, ...prev].slice(0, MAX_ROWS));
      } else if (message.channel === 'tcp-state') {
        const event = parseTcpStateEvent(message.payload);
        if (event === null) return;
        setStateEvents((prev) => [event, ...prev].slice(0, MAX_ROWS));
      } else if (message.channel === 'rtt') {
        const event = parseRttEvent(message.payload);
        if (event === null) return;
        setRttEvents((prev) => [event, ...prev].slice(0, MAX_ROWS));
      } else if (message.channel === 'retransmit') {
        const event = parseRetransmitEvent(message.payload);
        if (event === null) return;
        setRetransmitEvents((prev) => [event, ...prev].slice(0, MAX_ROWS));
      }
    };

    return () => ws.close();
  }, []);

  const builtins: Array<{ id: BuiltinView; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'frames', label: 'Frames' },
    { id: 'tcp', label: 'TCP' },
    { id: 'connections', label: 'Connections' },
    { id: 'rtt', label: 'RTT' },
    { id: 'retransmits', label: 'Retransmits' },
  ];

  const activeService =
    view === 'overview' ||
    view === 'frames' ||
    view === 'tcp' ||
    view === 'connections' ||
    view === 'rtt' ||
    view === 'retransmits'
      ? null
      : view;

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
          <a
            href="/export"
            style={{ ...sidebarButtonStyle(false), display: 'block', textDecoration: 'none' }}
          >
            Export .pcap
          </a>
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
        {view === 'connections' && <Connections events={stateEvents} />}
        {view === 'rtt' && <Rtt events={rttEvents} />}
        {view === 'retransmits' && <Retransmits events={retransmitEvents} />}
        {activeService !== null && <ServiceDetail name={activeService} />}
      </main>
    </div>
  );
}
