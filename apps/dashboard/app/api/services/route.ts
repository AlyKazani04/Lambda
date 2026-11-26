import { Redis } from 'ioredis';
import { NextResponse } from 'next/server';

import { services, type ServiceConfig } from '../../../lib/services';

export const dynamic = 'force-dynamic';

interface ServiceStatus {
  name: string;
  url: string;
  displayUrl?: string;
  status: 'up' | 'down';
  latencyMs?: number;
  detail?: unknown;
  error?: string;
}

// Each configured redis:// URL gets its own client. The previous implementation
// probed the default REDIS_URL connection via getReader() for every redis
// service, so multiple configured Redis instances all reported the health of
// the same endpoint. Keeping one client per URL fixes that; the connection is
// cached so repeated 2 s polls do not churn sockets.
const redisClients = new Map<string, Redis>();

function redisClientFor(url: string): Redis {
  let client = redisClients.get(url);
  if (client === undefined) {
    client = new Redis(url, {
      // Queue the first INFO until the client is ready so an up Redis shows as
      // up on the very first probe, but cap the wait so a dead one reports
      // "down" within a few seconds instead of hanging /api/services.
      commandTimeout: 3000,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
    // The probe surfaces failures in its result; swallow the event so an
    // unhandled 'error' cannot take down the dashboard process.
    client.on('error', () => {});
    redisClients.set(url, client);
  }
  return client;
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
      const info = await redisClientFor(service.url).info();
      return {
        name: service.name,
        url: service.url,
        displayUrl: service.displayUrl,
        status: 'up',
        latencyMs: performance.now() - start,
        detail: parseInfo(info),
      };
    } catch (err) {
      return {
        name: service.name,
        url: service.url,
        displayUrl: service.displayUrl,
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
      displayUrl: service.displayUrl,
      status: res.ok ? 'up' : 'down',
      latencyMs: performance.now() - start,
      detail,
    };
  } catch (err) {
    return {
      name: service.name,
      url: service.url,
      displayUrl: service.displayUrl,
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
