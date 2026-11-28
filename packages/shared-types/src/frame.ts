export type HopTag = 'client→proxy' | 'proxy→upstream';
export type FrameTlsMode = 'decrypt' | 'passthrough';

export interface FrameEvent {
  traceId: string;
  hop: HopTag;
  method: string;
  path: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  internalMs: number;
  timestamp: number;
  group?: string;
  upstream?: string;
  /** A8: set when the client-facing leg was TLS. */
  tlsMode?: FrameTlsMode;
  /** SNI hostname from the ClientHello, lowercased. */
  sni?: string;
  /** Decrypted request headers, redacted unless TLS_LOG_SECRETS is on. */
  headers?: Record<string, string>;
}
