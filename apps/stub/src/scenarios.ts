// Endpoint -> behaviour mapping (F3).
//
// Two layers, deliberately:
//   1. a default behaviour per path prefix
//   2. a per-request query override
//
// The load generator drives a *weighted distribution* of scenarios (F4), so it
// has to be able to say "this request should be slow, this one should reset".
// Path-only configuration cannot express that, so overrides win over defaults.

/** Behaviours the stub can produce. Each maps to a network phenomenon. */
export type Behaviour =
  | 'ok' // plain 200 JSON
  | 'status' // rotating 2xx/4xx/5xx
  | 'small' // ~1 KB JSON
  | 'large' // ~100 KB streamed
  | 'slow' // delayed response, /api/slow?ms=N
  | 'reset' // socket destroyed mid-response -> RST
  | 'close' // Connection: close -> extra handshakes
  | 'chunked'; // body streamed in N chunks -> multi-segment frames

/**
 * Default behaviour per path prefix. Longest prefix wins, so /api/slow is
 * matched before /api. `/timeline/*` is routed by the proxy (A1) and gets its
 * own behaviour set.
 */
export const DEFAULT_SCENARIOS: ReadonlyArray<{
  prefix: string;
  behaviour: Behaviour;
}> = [
  { prefix: '/api/status', behaviour: 'status' },
  { prefix: '/api/small', behaviour: 'small' },
  { prefix: '/api/large', behaviour: 'large' },
  { prefix: '/api/slow', behaviour: 'slow' },
  { prefix: '/api/reset', behaviour: 'reset' },
  { prefix: '/api/close', behaviour: 'close' },
  { prefix: '/api/chunked', behaviour: 'chunked' },
  // Burst is a generator-side concern; the stub just answers it normally.
  { prefix: '/api/burst', behaviour: 'ok' },
  { prefix: '/timeline', behaviour: 'small' },
  { prefix: '/api', behaviour: 'ok' },
];

/** Query parameter that overrides the default for a single request. */
export const OVERRIDE_PARAM = 'behaviour';

/**
 * Longest-prefix match over DEFAULT_SCENARIOS. Prefix semantics (not exact
 * equality) so /api/reset and /api/slow?ms=250 both belong to /api/*.
 */
export function defaultBehaviourFor(pathname: string): Behaviour {
  let match: Behaviour = 'ok';
  let matchLength = -1;

  for (const { prefix, behaviour } of DEFAULT_SCENARIOS) {
    if (pathname.startsWith(prefix) && prefix.length > matchLength) {
      match = behaviour;
      matchLength = prefix.length;
    }
  }

  return match;
}

/** True if `value` names a real behaviour. Used to reject `?behaviour=nonsense`. */
export function isBehaviour(value: string): value is Behaviour {
  return (
    value === 'ok' ||
    value === 'status' ||
    value === 'small' ||
    value === 'large' ||
    value === 'slow' ||
    value === 'reset' ||
    value === 'close' ||
    value === 'chunked'
  );
}
