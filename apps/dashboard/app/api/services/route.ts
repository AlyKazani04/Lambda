import { NextResponse } from 'next/server';

import { getReader } from '../../../lib/redis';
import { services, type ServiceConfig } from '../../../lib/services';

export const dynamic = 'force-dynamic';

interface ServiceStatus {
  name: string;
  url: string;
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: unknown;
  error?: string;
}

/** Parse Redis INFO into sections, e.g. { Server: { redis_version: '...' } }. */
function parseInfo(info: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = '';
  for (const line of info.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) {
      current = trimmed.slice(1).trim();
      sections[current] ??= {};
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const bucket = sections[current] ?? {};
    bucket[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    sections[current] = bucket;
  }
  return sections;
}

async function probe(service: ServiceConfig): Promise<ServiceStatus> {
  if (service.url.startsWith('redis://')) {
    const start = performance.now();
    try {
      const info = await getReader().info();
      return {
        name: service.name,
        url: service.url,
        status: 'up',
        latencyMs: performance.now() - start,
        detail: parseInfo(info),
      };
    } catch (err) {
      return {
        name: service.name,
        url: service.url,
        status: 'down',
        latencyMs: performance.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const healthUrl = `${service.url}${service.healthPath ?? '/health'}`;
  const start = performance.now();
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    let detail: unknown = text;
    try {
      detail = JSON.parse(text) as unknown;
    } catch {
      // keep the raw text
    }
    return {
      name: service.name,
      url: service.url,
      status: res.ok ? 'up' : 'down',
      latencyMs: performance.now() - start,
      detail,
    };
  } catch (err) {
    return {
      name: service.name,
      url: service.url,
      status: 'down',
      latencyMs: performance.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function GET() {
  const results = await Promise.all(services().map(probe));
  return NextResponse.json({ services: results });
}
