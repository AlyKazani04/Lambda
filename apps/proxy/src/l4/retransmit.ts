import { seqDiff, seqLess } from 'shared-types';
import type { ParsedPacket, RetransmitEvent } from 'shared-types';

const DEFAULT_MAX_RANGES = 256;
const DEFAULT_MAX_EVENTS = 1_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;
const DEFAULT_STALE_AFTER_MS = 15_000;

interface Range {
  seq: number;
  end: number;
  at: number;
}

interface AckState {
  ack: number;
  dupAcks: number;
}

interface Connection {
  ranges: Map<string, Range[]>;
  acks: Map<string, AckState>;
  segments: number;
  retransmits: number;
  lastSeen: number;
}

export interface RetransmitAnalyserOptions {
  publish?: (event: RetransmitEvent) => void;
  maxRanges?: number;
  maxEvents?: number;
  maxConnections?: number;
  staleAfterMs?: number;
  now?: () => number;
}

function endpointKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

function connectionKey(src: string, dst: string): string {
  return src <= dst ? `${src}|${dst}` : `${dst}|${src}`;
}

function rangeEnd(seq: number, length: number): number {
  return (seq + length) >>> 0;
}

function overlapBytes(a: Range, b: Range): number {
  const start = seqLess(a.seq, b.seq) ? b.seq : a.seq;
  const end = seqLess(a.end, b.end) ? a.end : b.end;
  return seqLess(end, start) ? 0 : seqDiff(end, start);
}

export class RetransmitAnalyser {
  private readonly connections = new Map<string, Connection>();
  private readonly events: RetransmitEvent[] = [];
  private readonly publish: (event: RetransmitEvent) => void;
  private readonly maxRanges: number;
  private readonly maxEvents: number;
  private readonly maxConnections: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private totalSegments = 0;
  private totalRetransmits = 0;

  constructor(options: RetransmitAnalyserOptions = {}) {
    this.publish = options.publish ?? (() => {});
    this.maxRanges = options.maxRanges ?? DEFAULT_MAX_RANGES;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
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

    if (tcp.flags.ack && packet.payload.length === 0 && !tcp.flags.syn) {
      const ackState = connection.acks.get(src) ?? { ack: 0, dupAcks: 0 };
      if (tcp.ack === ackState.ack) {
        ackState.dupAcks += 1;
      } else if (seqLess(ackState.ack, tcp.ack)) {
        ackState.ack = tcp.ack;
        ackState.dupAcks = 0;
      }
      connection.acks.set(src, ackState);
      return;
    }

    if (tcp.flags.syn || packet.payload.length === 0) return;

    connection.segments += 1;
    this.totalSegments += 1;

    const range: Range = {
      seq: tcp.seq,
      end: rangeEnd(tcp.seq, packet.payload.length),
      at: timestamp,
    };
    const seen = connection.ranges.get(src) ?? [];
    const overlaps = seen.filter((item) => overlapBytes(item, range) > 0);

    if (overlaps.length > 0) {
      connection.retransmits += 1;
      this.totalRetransmits += 1;
      const first = overlaps.reduce((earliest, item) => (item.at < earliest.at ? item : earliest));
      const ackState = connection.acks.get(dst);
      const fast =
        ackState !== undefined &&
        ackState.dupAcks >= 3 &&
        (ackState.ack === range.seq ||
          (seqLess(range.seq, ackState.ack) && seqLess(ackState.ack, range.end)));
      const cause = fast ? 'fast' : 'timeout';
      const [client, server] = key.split('|') as [string, string];
      const event: RetransmitEvent = {
        kind: overlaps.some((item) => item.seq === range.seq && item.end === range.end) ? 'full' : 'partial',
        cause,
        connectionId: key,
        client,
        server,
        from: src,
        timestamp,
        seq: range.seq,
        length: packet.payload.length,
        overlapBytes: overlaps.reduce((total, item) => total + overlapBytes(item, range), 0),
        delayMs: timestamp - first.at,
        observedRtoMs: cause === 'timeout' ? timestamp - first.at : null,
        dupAcks: ackState?.dupAcks ?? 0,
        rate: connection.retransmits / connection.segments,
        globalRate: this.totalRetransmits / this.totalSegments,
        truncated: packet.capturedLength < packet.originalLength,
      };
      this.events.push(event);
      if (this.events.length > this.maxEvents) this.events.shift();
      this.publish(event);
    }

    seen.push(range);
    if (seen.length > this.maxRanges) seen.shift();
    connection.ranges.set(src, seen);
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

  snapshot(): {
    connections: number;
    segments: number;
    retransmits: number;
    globalRate: number;
    events: readonly RetransmitEvent[];
  } {
    return {
      connections: this.connections.size,
      segments: this.totalSegments,
      retransmits: this.totalRetransmits,
      globalRate: this.totalSegments === 0 ? 0 : this.totalRetransmits / this.totalSegments,
      events: this.events,
    };
  }

  get size(): number {
    return this.connections.size;
  }

  private create(key: string): Connection {
    if (this.connections.size >= this.maxConnections) {
      const oldest = this.connections.keys().next().value;
      if (oldest !== undefined) this.connections.delete(oldest);
    }
    const connection: Connection = {
      ranges: new Map(),
      acks: new Map(),
      segments: 0,
      retransmits: 0,
      lastSeen: 0,
    };
    this.connections.set(key, connection);
    return connection;
  }
}
