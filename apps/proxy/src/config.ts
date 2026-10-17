// Proxy configuration (F2 / A1).

export interface UpstreamTarget {
  host: string;
  port: number;
}

export interface Route {
  prefix: string;
  group: string;
}

export interface ProxyConfig {
  host: string;
  port: number;
  routes: readonly Route[];
  explicitTargets: ReadonlyMap<string, readonly UpstreamTarget[]>;
  upstreamHost: string;
  upstreamPort: number;
  instanceCount: number;
  discoveryIntervalMs: number;
}

export const DEFAULT_ROUTES: readonly Route[] = [
  { prefix: '/api', group: 'api' },
  { prefix: '/timeline', group: 'timeline' },
];

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_UPSTREAM_HOST = '127.0.0.1';
export const DEFAULT_UPSTREAM_PORT = 3001;
export const DEFAULT_INSTANCE_COUNT = 3;
export const DEFAULT_DISCOVERY_INTERVAL_MS = 5000;

const TARGETS_ENV_PREFIX = 'UPSTREAM_TARGETS_';

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be an integer in 1..65535, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readNonNegativeInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

export function parseRoutes(raw: string | undefined): readonly Route[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ROUTES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`ROUTES must be JSON, got ${JSON.stringify(raw)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('ROUTES must be a non-empty JSON array of { prefix, group }');
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`ROUTES[${index}] must be an object`);
    }
    const { prefix, group } = entry as { prefix?: unknown; group?: unknown };
    if (typeof prefix !== 'string' || typeof group !== 'string' || group.trim() === '') {
      throw new Error(`ROUTES[${index}] needs a string prefix and a non-empty group`);
    }
    return { prefix: normalizePrefix(prefix), group: group.trim() };
  });
}

export function parseTargets(raw: string | undefined): readonly UpstreamTarget[] {
  if (raw === undefined || raw.trim() === '') return [];

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      if (/^\d+$/.test(entry)) {
        const port = Number(entry);
        if (port <= 0 || port > 65535) {
          throw new Error(`upstream target must be host:port, got ${JSON.stringify(entry)}`);
        }
        return { host: DEFAULT_UPSTREAM_HOST, port };
      }

      // Last colon, so a bracketed IPv6 literal survives.
      const separator = entry.lastIndexOf(':');
      if (separator <= 0) {
        throw new Error(`upstream target must be host:port, got ${JSON.stringify(entry)}`);
      }
      const host = entry.slice(0, separator).replace(/^\[|\]$/g, '');
      const port = Number(entry.slice(separator + 1));
      if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`upstream target must be host:port, got ${JSON.stringify(entry)}`);
      }
      return { host, port };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const routes = parseRoutes(env.ROUTES);

  const explicitTargets = new Map<string, readonly UpstreamTarget[]>();
  const sharedTargets = parseTargets(env.UPSTREAM_TARGETS);
  for (const group of new Set(routes.map((route) => route.group))) {
    const override = parseTargets(env[`${TARGETS_ENV_PREFIX}${group.toUpperCase()}`]);
    explicitTargets.set(group, override.length > 0 ? override : sharedTargets);
  }

  return {
    host: env.PROXY_HOST ?? '0.0.0.0',
    port: readInt(env, 'PROXY_PORT', DEFAULT_PROXY_PORT),
    routes,
    explicitTargets,
    upstreamHost: env.UPSTREAM_HOST ?? DEFAULT_UPSTREAM_HOST,
    upstreamPort: readInt(env, 'UPSTREAM_PORT', DEFAULT_UPSTREAM_PORT),
    instanceCount: readInt(env, 'UPSTREAM_INSTANCES', DEFAULT_INSTANCE_COUNT),
    discoveryIntervalMs: readNonNegativeInt(
      env,
      'UPSTREAM_DISCOVERY_INTERVAL_MS',
      DEFAULT_DISCOVERY_INTERVAL_MS,
    ),
  };
}
