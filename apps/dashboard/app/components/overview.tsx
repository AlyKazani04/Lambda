'use client';

import { useEffect, useState } from 'react';

interface ServiceStatus {
  name: string;
  url: string;
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: unknown;
  error?: string;
}

export default function Overview() {
  const [services, setServices] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/services');
        const data = (await res.json()) as { services: ServiceStatus[] };
        if (!cancelled) setServices(data.services);
      } catch {
        /* keep the last good view */
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div>
      <h2>Overview</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        {services.map((service) => (
          <div key={service.name} style={{ border: '1px solid #ddd', borderRadius: 6, padding: '1rem' }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
              <span style={{ color: service.status === 'up' ? 'green' : 'red' }}>●</span> {service.name}
            </h3>
            <p style={{ margin: '0.25rem 0', fontSize: '0.8rem', color: '#666' }}>{service.url}</p>
            {service.latencyMs !== undefined && (
              <p style={{ margin: '0.25rem 0', fontSize: '0.8rem' }}>{service.latencyMs.toFixed(1)} ms</p>
            )}
            <pre
              style={{
                fontSize: '0.7rem',
                overflow: 'auto',
                maxHeight: 180,
                background: '#f6f6f6',
                padding: '0.5rem',
              }}
            >
              {JSON.stringify(service.detail ?? service.error, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
