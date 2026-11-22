import type { ParsedPacket, RttEstimateEvent, RttSample } from 'shared-types';

export type { RttEstimateEvent, RttSample } from 'shared-types';

const ALPHA = 1 / 8;
const BETA = 1 / 4;
const K = 4;
const MIN_RTO_MS = 1_000;
const MAX_RTO_MS = 60_000;

export interface RttState {
  srttMs: number | null;
  rttvarMs: number | null;
  baseRtoMs: number | null;
  rtoMs: number;
  backedOff: boolean;
}

function boundRto(ms: number): number {
  return Math.min(MAX_RTO_MS, Math.max(MIN_RTO_MS, ms));
}

export class RttEstimator {
  private srttMs: number | null = null;
  private rttvarMs: number | null = null;
  private timerMs: number | null = null;

  observe(rttMs: number): RttState {
    if (this.srttMs === null) {
      this.srttMs = rttMs;
      this.rttvarMs = rttMs / 2;
    } else {
      const srtt = this.srttMs;
      const rttvar = this.rttvarMs!;
      this.rttvarMs = (1 - BETA) * rttvar + BETA * Math.abs(srtt - rttMs);
      this.srttMs = (1 - ALPHA) * srtt + ALPHA * rttMs;
    }
    this.timerMs = null;
    return this.snapshot();
  }

  retransmit(): RttState {
    const current = this.timerMs ?? boundRto(this.baseRto() ?? MIN_RTO_MS);
    this.timerMs = boundRto(current * 2);
    return this.snapshot();
  }

  acknowledged(): RttState {
    this.timerMs = null;
    return this.snapshot();
  }

  snapshot(): RttState {
    const srttMs = this.srttMs;
    const rttvarMs = this.rttvarMs;
    const baseRtoMs = this.baseRto();
    return {
      srttMs,
      rttvarMs,
      baseRtoMs,
      rtoMs: this.timerMs ?? boundRto(baseRtoMs ?? MIN_RTO_MS),
      backedOff: this.timerMs !== null,
    };
  }

  private baseRto(): number | null {
    const { srttMs, rttvarMs } = this;
    return srttMs === null || rttvarMs === null ? null : srttMs + K * rttvarMs;
  }
}

export interface RttAnalyserOptions {
  publish?: (event: RttEstimateEvent) => void;
  maxPending?: number;
  maxConnections?: number;
  staleAfterMs?: number;
  now?: () => number;
}

interface PendingSample {
  from: string;
  seq: number;
  endSeq: number;
  tsVal: number | null;
  sentAt: number;
}

interface Connection {
  estimator: RttEstimator;
  pending: PendingSample[];
  recentSeqs: Map<string, number[]>;
  lastSeen: number;
}

const DEFAULT_MAX_PENDING = 64;
const DEFAULT_MAX_RECENT_SEQS = 64;
const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_STALE_AFTER_MS = 15_000;

function endpointKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

function connectionKey(src: string, dst: string): string {
  return src <= dst ? `${src}|${dst}` : `${dst}|${src}`;
}

export class RttAnalyser {
  private readonly connections = new Map<string, Connection>();
  private readonly publish: (event: RttEstimateEvent) => void;
  private readonly maxPending: number;
  private readonly maxConnections: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(options: RttAnalyserOptions = {}) {
    this.publish = options.publish ?? (() => {});
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  observe(packet: ParsedPacket): void {
    const { fiveTuple, tcp, timestamp } = packet;
    const src = endpointKey(fiveTuple.srcIp, fiveTuple.srcPort);
    const dst = endpointKey(fiveTuple.dstIp, fiveTuple.dstPort);
    if (tcp.flags.rst) {
      this.connections.delete(connectionKey(src, dst));
      return;
    }

    const key = connectionKey(src, dst);
    const connection = this.connections.get(key) ?? this.create(key);
    connection.lastSeen = timestamp;

    if (packet.payload.length > 0 && !tcp.flags.syn) {
      const recent = connection.recentSeqs.get(src) ?? [];
      if (recent.includes(tcp.seq)) {
        connection.estimator.retransmit();
        this.emitState(key, connection, 'backoff', timestamp);
      } else {
        recent.push(tcp.seq);
        if (recent.length > DEFAULT_MAX_RECENT_SEQS) recent.shift();
        connection.recentSeqs.set(src, recent);
      }
      connection.pending.push({
        from: src,
        seq: tcp.seq,
        endSeq: (tcp.seq + packet.payload.length) >>> 0,
        tsVal: tcp.options.timestamps?.tsVal ?? null,
        sentAt: timestamp,
      });
      if (connection.pending.length > this.maxPending) connection.pending.shift();
    }

    let method: RttSample['method'] = 'timestamp';
    let index = -1;
    const tsEcr = tcp.options.timestamps?.tsEcr;
    if (tsEcr !== undefined) {
      index = connection.pending.findIndex((item) => item.from !== src && item.tsVal === tsEcr);
    }
    if (index === -1 && tcp.flags.ack) {
      index = connection.pending.findIndex((item) => item.from !== src && item.endSeq === tcp.ack);
      method = 'seq-ack';
    }
    if (index !== -1) {
      const pending = connection.pending[index]!;
      connection.pending.splice(index, 1);
      if (timestamp >= pending.sentAt) {
        this.emit(key, connection, {
          timestamp,
          rttMs: timestamp - pending.sentAt,
          method,
          from: pending.from,
        });
      }
    }

    if (tcp.flags.ack && packet.payload.length === 0 && connection.estimator.snapshot().backedOff) {
      connection.estimator.acknowledged();
      this.emitState(key, connection, 'ack', timestamp);
    }
  }

  sweep(now: number = this.now()): number {
    let removed = 0;
    for (const [key, connection] of this.connections) {
      if (now - connection.lastSeen <= this.staleAfterMs) continue;
      this.connections.delete(key);
      removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.connections.size;
  }

  get pendingCount(): number {
    let total = 0;
    for (const connection of this.connections.values()) total += connection.pending.length;
    return total;
  }

  private create(key: string): Connection {
    if (this.connections.size >= this.maxConnections) {
      const oldest = this.connections.keys().next().value;
      if (oldest !== undefined) this.connections.delete(oldest);
    }
    const connection: Connection = {
      estimator: new RttEstimator(),
      pending: [],
      recentSeqs: new Map(),
      lastSeen: 0,
    };
    this.connections.set(key, connection);
    return connection;
  }

  private emit(key: string, connection: Connection, sample: RttSample): void {
    connection.estimator.observe(sample.rttMs);
    this.emitState(key, connection, 'sample', sample.timestamp, sample);
  }

  private emitState(
    key: string,
    connection: Connection,
    kind: RttEstimateEvent['kind'],
    timestamp: number,
    sample?: RttSample,
  ): void {
    const [client, server] = key.split('|') as [string, string];
    this.publish({
      kind,
      connectionId: key,
      client,
      server,
      timestamp,
      ...(sample === undefined ? {} : { sample }),
      ...connection.estimator.snapshot(),
    });
  }
}
