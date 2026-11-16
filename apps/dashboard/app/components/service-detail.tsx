'use client';

import { useServices } from '../../lib/use-services';

export default function ServiceDetail({ name }: { name: string }) {
  const services = useServices();
  const service = services.find((entry) => entry.name === name) ?? null;

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
