// Proxy configuration (F2 / A1).
//
// The routing table and the upstream instance list are deployment inputs, not
// constants in the request path: `--scale stub=3` changes the instance count
// with no code change, and ROUTES changes the table.

/** One upstream instance, as the forwarder needs it. */
export interface UpstreamTarget {
  host: string;
  port: number;
}

/** A path prefix and the name of the upstream group that serves it. */
export interface Route {
  prefix: string;
  group: string;
}

export interface ProxyConfig {
  /** Interface to bind. 0.0.0.0 rather than localhost: Laptop B connects over
   * the network, and a loopback bind is unreachable from another machine. */
  host: string;
  port: number;
  routes: readonly Route[];
  /**
   * Explicit instance lists, keyed by upstream group. A group missing here (or
   * mapped to an empty list) is resolved from the hostname instead — that is
   * the compose-scaling path.
   */
  explicitTargets: ReadonlyMap<string, readonly UpstreamTarget[]>;
  /** Hostname resolved to an instance list when no explicit targets are given. */
  upstreamHost: string;
  upstreamPort: number;
  /** Ceiling on resolved instances. Ignored for groups with explicit targets,
   * where the list length *is* the count. */
  instanceCount: number;
  /**
   * How often to re-resolve the upstream hostname, in ms. 0 disables it.
   *
   * Not a nicety: `depends_on: service_healthy` waits for one replica of a
   * service, not all N, so under `--scale stub=3` the proxy can resolve the
   * service name before the other replicas register and cache a one-instance
   * list forever. Re-resolving is what makes the rotation correct regardless of
   * start order, and what lets a runtime `--scale` take effect.
   */
  discoveryIntervalMs: number;
}

/** Path prefix -> upstream group. Overridable via the ROUTES env var. */
export const DEFAULT_ROUTES: readonly Route[] = [
  { prefix: '/api', group: 'api' },
  { prefix: '/timeline', group: 'timeline' },
];

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_UPSTREAM_HOST = '127.0.0.1';
export const DEFAULT_UPSTREAM_PORT = 3001;
export const DEFAULT_INSTANCE_COUNT = 3;
export const DEFAULT_DISCOVERY_INTERVAL_MS = 5000;

/** Per-group override for UPSTREAM_TARGETS, e.g. UPSTREAM_TARGETS_TIMELINE. */
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

/** Like readInt but allows 0, for "disable this" settings. */
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

/** Leading slash added, trailing slashes dropped, so `/api/` and `/api` are one route. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

/** Parse `ROUTES` (JSON) or fall back to the built-in table. */
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

/**
 * Parse `host:port,host:port`. A bare integer is shorthand for
 * `127.0.0.1:<port>`. Empty or absent means "no explicit targets", which sends
 * the caller down the DNS resolution path.
 */
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

  // A per-group UPSTREAM_TARGETS_<GROUP> beats the shared UPSTREAM_TARGETS, so
  // one group can point at a genuinely different upstream.
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
