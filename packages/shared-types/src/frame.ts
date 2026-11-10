export type HopTag = 'client→proxy' | 'proxy→upstream';

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
}
