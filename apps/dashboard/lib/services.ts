export interface ServiceConfig {
  name: string;
  /** http(s):// for health probes, redis:// for INFO. */
  url: string;
  healthPath?: string;
}

/**
 * The live stack the dashboard shows. Defaults to the local run; override with
 * DASHBOARD_SERVICES as a JSON array when the stack runs under compose.
 */
const DEFAULT_SERVICES: readonly ServiceConfig[] = [
  { name: 'proxy', url: 'http://127.0.0.1:8080', healthPath: '/health' },
  { name: 'dashboard', url: 'http://127.0.0.1:3000', healthPath: '/api/time' },
  { name: 'stub', url: 'http://127.0.0.1:3001', healthPath: '/health' },
  { name: 'redis', url: 'redis://127.0.0.1:6379' },
  { name: 'test-upstream', url: 'http://127.0.0.1:3100', healthPath: '/api/echo' },
  { name: 'test-proxy', url: 'http://127.0.0.1:8081', healthPath: '/health' },
];

export function services(): ServiceConfig[] {
  const raw = process.env.DASHBOARD_SERVICES;
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_SERVICES];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_SERVICES];
    return parsed.filter((entry): entry is ServiceConfig => {
      if (typeof entry !== 'object' || entry === null) return false;
      const { name, url } = entry as { name?: unknown; url?: unknown };
      return typeof name === 'string' && typeof url === 'string';
    });
  } catch {
    return [...DEFAULT_SERVICES];
  }
}
