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

export default function ServiceDetail({ name }: { name: string }) {
  const [service, setService] = useState<ServiceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/services');
        const data = (await res.json()) as { services: ServiceStatus[] };
        if (!cancelled) {
          setService(data.services.find((entry) => entry.name === name) ?? null);
        }
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
  }, [name]);

  if (service === null) {
    return <p>Loading {name}…</p>;
  }

  return (
    <div>
      <h2>{service.name}</h2>
      <p>
        {service.url} — {service.status === 'up' ? 'up' : 'down'}
        {service.latencyMs !== undefined ? ` (${service.latencyMs.toFixed(1)} ms)` : ''}
      </p>
      <pre style={{ background: '#f6f6f6', padding: '1rem', overflow: 'auto' }}>
        {JSON.stringify(service.detail ?? service.error, null, 2)}
      </pre>
    </div>
  );
}
