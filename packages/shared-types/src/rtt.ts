export interface RttSample {
  timestamp: number;
  rttMs: number;
  method: 'timestamp' | 'seq-ack';
  from: string;
}

export interface RttEstimateEvent {
  kind: 'sample' | 'backoff' | 'ack';
  connectionId: string;
  client: string;
  server: string;
  timestamp: number;
  sample?: RttSample;
  srttMs: number | null;
  rttvarMs: number | null;
  baseRtoMs: number | null;
  rtoMs: number;
  backedOff: boolean;
}
