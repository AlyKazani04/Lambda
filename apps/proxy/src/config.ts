// Proxy configuration (F2 / A1).

import { DEFAULT_HISTORY_LIMIT } from 'shared-types';

export interface UpstreamTarget {
  host: string;
  port: number;
}

export interface Route {
  prefix: string;
  group: string;
}

export type TlsMode = 'decrypt' | 'passthrough';

export interface TlsHostRoute {
  /** Lowercased SNI hostname, matched exactly. */
  host: string;
  mode: TlsMode;
  /** Decrypt path: upstream group to route the plaintext request to. */
  group?: string;
  /** Decrypt path: per-host certificate, overriding the global pair. */
  certFile?: string;
  keyFile?: string;
  /** Passthrough path: raw TLS upstream, e.g. 127.0.0.1:8444. */
  target?: UpstreamTarget;
}

export interface ProxyConfig {
  host: string;
  port: number;
  routes: readonly Route[];
  explicitTargets: ReadonlyMap<string, readonly UpstreamTarget[]>;
  upstreamHost: string;
  upstreamPort: number;
  instanceCount: number;
  captureIface: string;

  discoveryIntervalMs: number;
  /** Redis URL for the frame/TCP pub-sub bus. */
  redisUrl: string;
  /** Capped history list length. */
  historyLimit: number;

  /** A4: progress-based idle detection, all thresholds in milliseconds. */
  slowlorisEnabled: boolean;
  slowlorisTtfbMs: number;
  slowlorisHeadersMs: number;
  slowlorisBodyMs: number;
  slowlorisIdleMs: number;

  /** A8: TLS termination and SNI routing. Disabled by default. */
  tlsEnabled: boolean;
  tlsPort: number;
  tlsCertFile: string;
  tlsKeyFile: string;
  tlsHosts: readonly TlsHostRoute[];
  /** Frame logs include credential headers only when this is explicitly on. */
  tlsLogSecrets: boolean;
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
export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
export const DEFAULT_SLOWLORIS_TTFB_MS = 10_000;
export const DEFAULT_SLOWLORIS_HEADERS_MS = 15_000;
export const DEFAULT_SLOWLORIS_BODY_MS = 30_000;
export const DEFAULT_SLOWLORIS_IDLE_MS = 60_000;
export const DEFAULT_TLS_PORT = 8443;

// The default cert pair is only a fallback for hosts that do not name their
// own files. Keeping the path in config rather than in code lets the same
// compiled image use different certs on each machine.
export const DEFAULT_TLS_CERT_FILE = '';
export const DEFAULT_TLS_KEY_FILE = '';

// Node's own timeouts are total-time limits and give no reason when they fire,
// so the A4 watchdog remains the reporting authority. It must not be the only
// protection though: when it is disabled, or if its timer never runs, a client
// could otherwise hold a socket forever. A ceiling just above the longest
// watchdog threshold covers both cases while letting the watchdog fire first.
export function timeoutBackstopMs(config: ProxyConfig): number {
  return Math.max(
    config.slowlorisTtfbMs,
    config.slowlorisHeadersMs,
    config.slowlorisBodyMs,
    config.slowlorisIdleMs,
  ) + 1000;
}

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

// Millisecond thresholds can exceed readInt's 65535 ceiling (ports), so they
// need their own parser. Upper bound is one hour: beyond that the detector is
// effectively disabled and a typo should be caught rather than silently
// accepted.
function readTimeoutMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 3_600_000) {
    throw new Error(`${name} must be an integer number of milliseconds in 1..3600000, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readEnabledWithDefault(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(env[name])}`);
}

function readEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
  return readEnabledWithDefault(env, name, true);
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

/**
 * A8: one entry per SNI hostname. SNI is case-insensitive on the wire, so
 * hostnames are normalised here and compared exactly at lookup time; wildcard
 * matching is deliberately out of scope.
 */
export function parseTlsHosts(raw: string | undefined): readonly TlsHostRoute[] {
  if (raw === undefined || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`TLS_SNI_ROUTES must be JSON, got ${JSON.stringify(raw)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('TLS_SNI_ROUTES must be a non-empty JSON array when set');
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`TLS_SNI_ROUTES[${index}] must be an object`);
    }
    const { host, mode, group, certFile, keyFile, target } = entry as Record<string, unknown>;
    if (typeof host !== 'string' || host.trim() === '') {
      throw new Error(`TLS_SNI_ROUTES[${index}] needs a string host`);
    }
    const hostname = host.trim().toLowerCase();
    if (seen.has(hostname)) {
      throw new Error(`TLS_SNI_ROUTES has a duplicate host: ${hostname}`);
    }
    seen.add(hostname);

    if (mode !== 'decrypt' && mode !== 'passthrough') {
      throw new Error(`TLS_SNI_ROUTES[${index}].mode must be decrypt or passthrough`);
    }

    const optionalString = (value: unknown, field: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`TLS_SNI_ROUTES[${index}].${field} must be a non-empty string`);
      }
      return value.trim();
    };

    if (mode === 'decrypt') {
      if (typeof group !== 'string' || group.trim() === '') {
        throw new Error(`TLS_SNI_ROUTES[${index}] decrypt needs a group`);
      }
      return {
        host: hostname,
        mode,
        group: group.trim(),
        ...(certFile === undefined ? {} : { certFile: optionalString(certFile, 'certFile') }),
        ...(keyFile === undefined ? {} : { keyFile: optionalString(keyFile, 'keyFile') }),
      };
    }

    if (typeof target !== 'string' || target.trim() === '') {
      throw new Error(`TLS_SNI_ROUTES[${index}] passthrough needs a host:port target`);
    }
    const targets = parseTargets(target);
    if (targets.length !== 1) {
      throw new Error(`TLS_SNI_ROUTES[${index}].target must be exactly one host:port`);
    }
    return { host: hostname, mode, target: targets[0] };
  });
}

/** Fail fast on missing key material rather than at the first handshake. */
export function validateTlsConfig(config: ProxyConfig): void {
  if (!config.tlsEnabled) return;
  if (config.tlsHosts.length === 0) {
    throw new Error('TLS_ENABLED requires at least one TLS_SNI_ROUTES host');
  }
  for (const host of config.tlsHosts) {
    if (host.mode !== 'decrypt') continue;
    if ((host.certFile ?? config.tlsCertFile) === '' || (host.keyFile ?? config.tlsKeyFile) === '') {
      throw new Error(`TLS certificate and key are required for ${host.host}`);
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const routes = parseRoutes(env.ROUTES);

  const explicitTargets = new Map<string, readonly UpstreamTarget[]>();
  const sharedTargets = parseTargets(env.UPSTREAM_TARGETS);
  for (const group of new Set(routes.map((route) => route.group))) {
    const override = parseTargets(env[`${TARGETS_ENV_PREFIX}${group.toUpperCase()}`]);
    explicitTargets.set(group, override.length > 0 ? override : sharedTargets);
  }

  const config: ProxyConfig = {
    host: env.PROXY_HOST ?? '0.0.0.0',
    port: readInt(env, 'PROXY_PORT', DEFAULT_PROXY_PORT),
    routes,
    explicitTargets,
    upstreamHost: env.UPSTREAM_HOST ?? DEFAULT_UPSTREAM_HOST,
    upstreamPort: readInt(env, 'UPSTREAM_PORT', DEFAULT_UPSTREAM_PORT),
    instanceCount: readInt(env, 'UPSTREAM_INSTANCES', DEFAULT_INSTANCE_COUNT),
    captureIface: (env.CAPTURE_IFACE ?? '').trim(),
    discoveryIntervalMs: readNonNegativeInt(
      env,
      'UPSTREAM_DISCOVERY_INTERVAL_MS',
      DEFAULT_DISCOVERY_INTERVAL_MS,
    ),
    redisUrl: env.REDIS_URL ?? DEFAULT_REDIS_URL,
    historyLimit: readInt(env, 'HISTORY_LIMIT', DEFAULT_HISTORY_LIMIT),
    slowlorisEnabled: readEnabled(env, 'SLOWLORIS_ENABLED'),
    slowlorisTtfbMs: readTimeoutMs(env, 'SLOWLORIS_TTFB_MS', DEFAULT_SLOWLORIS_TTFB_MS),
    slowlorisHeadersMs: readTimeoutMs(env, 'SLOWLORIS_HEADERS_MS', DEFAULT_SLOWLORIS_HEADERS_MS),
    slowlorisBodyMs: readTimeoutMs(env, 'SLOWLORIS_BODY_MS', DEFAULT_SLOWLORIS_BODY_MS),
    slowlorisIdleMs: readTimeoutMs(env, 'SLOWLORIS_IDLE_MS', DEFAULT_SLOWLORIS_IDLE_MS),
    tlsEnabled: readEnabledWithDefault(env, 'TLS_ENABLED', false),
    tlsPort: readInt(env, 'TLS_PORT', DEFAULT_TLS_PORT),
    tlsCertFile: env.TLS_CERT_FILE?.trim() ?? DEFAULT_TLS_CERT_FILE,
    tlsKeyFile: env.TLS_KEY_FILE?.trim() ?? DEFAULT_TLS_KEY_FILE,
    tlsHosts: parseTlsHosts(env.TLS_SNI_ROUTES),
    tlsLogSecrets: readEnabledWithDefault(env, 'TLS_LOG_SECRETS', false),
  };

  validateTlsConfig(config);
  return config;
}
