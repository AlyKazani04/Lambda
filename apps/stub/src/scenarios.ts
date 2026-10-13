// Behaviours stub can produce.
export type Behaviour =
  | 'ok'        // plain 200 JSON
  | 'status'    // rotating 2xx/4xx/5xx
  | 'small'     // ~1 KB JSON
  | 'large'     // ~100 KB streamed
  | 'slow'      // delayed response, /api/slow?ms=N
  | 'reset'     // socket destroyed mid-response -> RST
  | 'close'     // Connection: close -> extra handshakes
  | 'chunked';  // body streamed in N chunks -> multi-segment frames


// Default behaviour per path prefix. Longest prefix wins
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
    { prefix: '/api/burst', behaviour: 'ok' },
    { prefix: '/timeline', behaviour: 'small' },
    { prefix: '/api', behaviour: 'ok' },
  ];

export const OVERRIDE_PARAM = 'behaviour';

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
