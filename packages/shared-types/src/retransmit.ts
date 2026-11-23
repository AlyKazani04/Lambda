export interface RetransmitEvent {
  kind: 'full' | 'partial';
  cause: 'fast' | 'timeout';
  connectionId: string;
  client: string;
  server: string;
  from: string;
  timestamp: number;
  seq: number;
  length: number;
  overlapBytes: number;
  delayMs: number;
  observedRtoMs: number | null;
  dupAcks: number;
  rate: number;
  globalRate: number;
  truncated: boolean;
}
