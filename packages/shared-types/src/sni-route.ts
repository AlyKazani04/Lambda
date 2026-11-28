import type { FrameTlsMode } from './frame.js';

/**
 * A8: a routing decision made on SNI alone. Passthrough traffic is never
 * decrypted, so this event deliberately has no method, path or headers —
 * those are exactly the fields the proxy cannot know without breaking TLS.
 */
export interface SniRouteEvent {
  host: string;
  mode: FrameTlsMode;
  upstream: string;
  requestBytes: number;
  timestamp: number;
}
