// Path-prefix routing (F2 / A1).

import type { Route } from './config.js';

export function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true;
  if (pathname === prefix) return true;
  return pathname.startsWith(`${prefix}/`);
}

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

export function pathnameOf(requestTarget: string | undefined): string | null {
  if (requestTarget === undefined || requestTarget === '') return null;
  try {
    return new URL(requestTarget, 'http://proxy.invalid').pathname;
  } catch {
    return null;
  }
}
