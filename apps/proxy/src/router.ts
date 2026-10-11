// Path-prefix routing (F2 / A1).
//
// Prefix matching must respect segment boundaries: a naive `startsWith('/api')`
// also matches `/apifoo`, which is a different resource and would silently route
// to the wrong upstream.

import type { Route } from './config.js';

/**
 * True when `pathname` is the prefix itself or lies underneath it.
 *
 * `/api`  matches /api and /api/x
 * `/api`  does NOT match /apifoo or /api-docs
 * `/`     matches everything (a catch-all route)
 */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
}

/**
 * Longest matching prefix wins, so `/api/admin` takes precedence over `/api`
 * without reordering the table. Null when nothing matches — the caller answers
 * that with a 404 rather than an exception.
 */
export function matchRoute(
  pathname: string,
  routes: readonly Route[],
): Route | null {
  let best: Route | null = null;

  for (const route of routes) {
    if (!matchesPrefix(pathname, route.prefix)) continue;
    if (best === null || route.prefix.length > best.prefix.length) {
      best = route;
    }
  }

  return best;
}

/**
 * The path portion of an origin-form request target, or null when the target is
 * not parseable (absolute-form from an old client, garbage from a probe).
 */
export function pathnameOf(requestTarget: string | undefined): string | null {
  if (requestTarget === undefined || requestTarget === '') return null;
  try {
    return new URL(requestTarget, 'http://proxy.invalid').pathname;
  } catch {
    return null;
  }
}
