// A4 slowloris detection event. Published when the proxy closes a connection
// that has stopped making progress in one of the request lifecycle phases.
export type SlowlorisPhase = 'ttfb' | 'headers' | 'body' | 'idle';

export interface SlowlorisEvent {
  phase: SlowlorisPhase;
  /** Machine-readable cause, e.g. 'no_bytes_before_first_byte'. */
  reason: string;
  client: string;
  /** Time since the last byte received in this phase, in milliseconds. */
  elapsedMs: number;
  /** Bytes received in this phase before the timeout fired. */
  bytesReceived: number;
  timestamp: number;
  /** Set only once the request has reached route matching. */
  traceId?: string;
  path?: string;
}
