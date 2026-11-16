// B3 — TCP three-way handshake timing analyser.
//
// Consumes already-decoded packets (packet-parser.ts) and answers one question
// per connection: how long did each step of SYN → SYN-ACK → ACK take?
//
// The analyser is deliberately decoupled from capture and from the dashboard:
// it takes ParsedPacket values and emits results through a HandshakePublisher.
// The Redis/dashboard adapter is a separate concern wired in index.ts.
//
// Timestamps are always the capture timestamp carried on the packet, never
// Date.now(). The capture timestamp is when the packet arrived; Date.now() is
// when we got around to processing it, and under load the two differ by more
// than the intervals being measured here.

import type { ParsedPacket } from 'shared-types';

export interface HandshakeEndpoint {
  ip: string;
  port: number;
}

/** One completed handshake, with the timings the issue asks for. */
export interface HandshakeResult {
  /** Canonical connection identity, `client>server`. */
  connectionId: string;
  client: HandshakeEndpoint;
  server: HandshakeEndpoint;
  /** Capture timestamps (ms). */
  tSyn: number;
  tSynAck: number;
  tAck: number;
  synToSynAckMs: number;
  synAckToAckMs: number;
  totalMs: number;
  /**
   * totalMs / 2 — an ESTIMATE of round-trip time, not a measurement.
   *
   * It assumes a SYMMETRIC path: request and response travel equally fast.
   * Real WiFi/LAN paths are asymmetric (different queues, interference, ACK
   * compression), so treat this as a lower-fidelity figure than B5's
   * per-packet RTT estimation, which does not rely on the assumption.
   */
  rttEstimateMs: number;
  synSeq: number;
  synAckSeq: number;
  /** Retransmitted SYNs seen for this connection (analysis is B4's job). */
  synRetransmits: number;
}

export interface HandshakeStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface HandshakeAggregate {
  /** Cumulative count since start; never reset. */
  completedCount: number;
  inProgressCount: number;
  staleCount: number;
  /** SYN-ACKs rejected because their ACK did not acknowledge our SYN. */
  synAckMismatches: number;
  /** Final ACKs rejected because their ACK did not acknowledge the SYN-ACK. */
  ackMismatches: number;
  /** Number of results retained in the window the stats describe. */
  windowSize: number;
  totalMs: HandshakeStats | null;
  rttEstimateMs: HandshakeStats | null;
}

/**
 * The seam the dashboard plugs into. `publishConnection` fires once per
 * completed handshake; `publishAggregate` fires on every sweep tick. Both are
 * optional so the analyser is usable with no bus at all.
 */
export interface HandshakePublisher {
  publishConnection?(result: HandshakeResult): void;
  publishAggregate?(snapshot: HandshakeAggregate): void;
}

export interface HandshakeOptions {
  /** Drop an in-progress connection silent for this long. Default 15s. */
  staleAfterMs?: number;
  /**
   * Bound on retained completed results (a ring buffer). This is what keeps
   * memory flat: the in-progress map is bounded by `staleAfterMs`, and the
   * completed history is bounded by this. Default 1000.
   */
  maxCompleted?: number;
  /** Sweep interval in ms; 0 disables the timer (tests drive sweep()). */
  sweepIntervalMs?: number;
  /** Injectable clock, so expiry is deterministic under test. */
  now?: () => number;
  publisher?: HandshakePublisher;
  log?: (line: string) => void;
}

const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_MAX_COMPLETED = 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

interface ConnectionRecord {
  client: HandshakeEndpoint;
  server: HandshakeEndpoint;
  tSyn: number;
  synSeq: number;
  synRetransmits: number;
  tSynAck: number | null;
  synAckSeq: number | null;
  tAck: number | null;
  lastSeen: number;
}

function endpointKey(endpoint: HandshakeEndpoint): string {
  return `${endpoint.ip}:${endpoint.port}`;
}

/**
 * Direction-insensitive connection identity. The SYN travels client→server and
 * the SYN-ACK travels server→client, so the two directions of one connection
 * must map to the same key. Ordering the endpoint pair lexicographically is
 * enough: it is deterministic, and the full `ip:port` pair is what
 * distinguishes two connections between the same hosts.
 */
function connectionKey(a: HandshakeEndpoint, b: HandshakeEndpoint): string {
  const left = endpointKey(a);
  const right = endpointKey(b);
  return left <= right ? `${left}|${right}` : `${right}|${left}`;
}

/** True when `ack` acknowledges `seq + 1`, with 32-bit sequence wraparound. */
function acknowledges(ack: number, seq: number): boolean {
  return ack === ((seq + 1) >>> 0);
}

/**
 * Nearest-rank percentile over an already-sorted array. Exact for the retained
 * sample; with small samples it reports a value that is actually present rather
 * than an interpolation that describes no measurement.
 */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

function summarize(values: readonly number[]): HandshakeStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const value of sorted) sum += value;

  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

export class HandshakeAnalyser {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly completed: HandshakeResult[] = [];
  private readonly staleAfterMs: number;
  private readonly maxCompleted: number;
  private readonly now: () => number;
  private readonly publisher: HandshakePublisher;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;

  private totalCompleted = 0;
  private staleCount = 0;
  private synAckMismatches = 0;
  private ackMismatches = 0;

  constructor(options: HandshakeOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED;
    this.now = options.now ?? (() => Date.now());
    this.publisher = options.publisher ?? {};
    this.log = options.log ?? (() => {});

    const interval = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => this.tick(), interval);
      // The sweep must never be the reason the process stays alive.
      this.timer.unref();
    }
  }

  /** Feed one decoded packet. Safe to call for every captured packet. */
  observe(packet: ParsedPacket): void {
    const { fiveTuple, tcp, timestamp } = packet;
    const flags = tcp.flags;

    const src: HandshakeEndpoint = { ip: fiveTuple.srcIp, port: fiveTuple.srcPort };
    const dst: HandshakeEndpoint = { ip: fiveTuple.dstIp, port: fiveTuple.dstPort };

    // A SYN-ACK has BOTH SYN and ACK set. Testing `flags.syn` alone would match
    // it too and every SYN-ACK would be miscounted as a new connection opening.
    // RST is excluded on both handshake packets: a RST is a failed connection,
    // not a step in a successful handshake.
    if (flags.syn && !flags.ack && !flags.rst) {
      this.onSyn(src, dst, tcp.seq, timestamp);
    } else if (flags.syn && flags.ack && !flags.rst) {
      this.onSynAck(src, dst, tcp.seq, tcp.ack, timestamp);
    } else if (flags.ack && !flags.rst) {
      this.onAck(src, dst, tcp.ack, timestamp);
    }
  }

  /** Expire stale connections and publish the aggregate. Runs on the timer. */
  tick(): void {
    this.sweep(this.now());
    this.publisher.publishAggregate?.(this.snapshot());
  }

  /** Drop in-progress connections silent for longer than `staleAfterMs`. */
  sweep(now: number = this.now()): number {
    let expired = 0;
    for (const [key, record] of this.connections) {
      if (now - record.lastSeen > this.staleAfterMs) {
        this.connections.delete(key);
        this.staleCount += 1;
        expired += 1;
      }
    }

    if (expired > 0) {
      this.log(`handshake: expired ${expired} stale connection(s)`);
    }
    return expired;
  }

  /** Aggregate over the retained completed-handshake window. */
  snapshot(): HandshakeAggregate {
    return {
      completedCount: this.totalCompleted,
      inProgressCount: this.connections.size,
      staleCount: this.staleCount,
      synAckMismatches: this.synAckMismatches,
      ackMismatches: this.ackMismatches,
      windowSize: this.completed.length,
      totalMs: summarize(this.completed.map((result) => result.totalMs)),
      rttEstimateMs: summarize(this.completed.map((result) => result.rttEstimateMs)),
    };
  }

  /** Retained completed results, oldest first. Bounded by `maxCompleted`. */
  results(): readonly HandshakeResult[] {
    return this.completed;
  }

  get inProgressCount(): number {
    return this.connections.size;
  }

  get completedCount(): number {
    return this.totalCompleted;
  }

  /** Stop the sweep timer. Does not clear retained results. */
  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private onSyn(src: HandshakeEndpoint, dst: HandshakeEndpoint, seq: number, timestamp: number): void {
    const key = connectionKey(src, dst);
    const existing = this.connections.get(key);

    if (existing !== undefined) {
      if (existing.synSeq === seq) {
        // Retransmitted SYN: same ISN, so it is the same connection attempt.
        // Count it (B4 owns retransmission analysis) but keep the first t_syn —
        // the handshake started when the first SYN arrived.
        existing.synRetransmits += 1;
        existing.lastSeen = timestamp;
        return;
      }

      // Same 5-tuple, different ISN: the previous attempt was abandoned (RST or
      // a client gave up). Replace it rather than leaking the old record.
      this.connections.delete(key);
      this.staleCount += 1;
    }

    this.connections.set(key, {
      client: src,
      server: dst,
      tSyn: timestamp,
      synSeq: seq,
      synRetransmits: 0,
      tSynAck: null,
      synAckSeq: null,
      tAck: null,
      lastSeen: timestamp,
    });
  }

  private onSynAck(
    src: HandshakeEndpoint,
    dst: HandshakeEndpoint,
    seq: number,
    ack: number,
    timestamp: number,
  ): void {
    const key = connectionKey(src, dst);
    const record = this.connections.get(key);

    // No SYN seen for this 5-tuple: a capture that started mid-handshake, or an
    // unsolicited SYN-ACK. Either way there is no handshake to time.
    if (record === undefined) return;

    // Retransmitted SYN-ACK: keep the first arrival.
    if (record.tSynAck !== null) return;

    // The SYN-ACK must acknowledge our SYN's sequence + 1. A mismatch means this
    // SYN-ACK belongs to a different connection attempt and must not be matched.
    if (!acknowledges(ack, record.synSeq)) {
      this.synAckMismatches += 1;
      return;
    }

    record.tSynAck = timestamp;
    record.synAckSeq = seq;
    record.lastSeen = timestamp;
  }

  private onAck(src: HandshakeEndpoint, dst: HandshakeEndpoint, ack: number, timestamp: number): void {
    const key = connectionKey(src, dst);
    const record = this.connections.get(key);

    if (record === undefined) return;
    if (record.tAck !== null) return;
    // Without an observed SYN-ACK there is nothing to complete; an ACK that
    // arrives first is a capture-order artefact, not a handshake.
    if (record.tSynAck === null || record.synAckSeq === null) return;

    // The final ACK must acknowledge the SYN-ACK's sequence + 1.
    if (!acknowledges(ack, record.synAckSeq)) {
      this.ackMismatches += 1;
      return;
    }

    record.tAck = timestamp;
    const result = this.toResult(record);

    // Completion moves the record out of the in-progress map, which is what
    // keeps the registry bounded for connections that do finish.
    this.connections.delete(key);
    this.totalCompleted += 1;
    this.completed.push(result);
    if (this.completed.length > this.maxCompleted) {
      this.completed.shift();
    }

    this.publisher.publishConnection?.(result);
  }

  private toResult(record: ConnectionRecord): HandshakeResult {
    const tSynAck = record.tSynAck!;
    const tAck = record.tAck!;
    const totalMs = tAck - record.tSyn;

    return {
      connectionId: `${endpointKey(record.client)}>${endpointKey(record.server)}`,
      client: record.client,
      server: record.server,
      tSyn: record.tSyn,
      tSynAck,
      tAck,
      synToSynAckMs: tSynAck - record.tSyn,
      synAckToAckMs: tAck - tSynAck,
      totalMs,
      rttEstimateMs: totalMs / 2,
      synSeq: record.synSeq,
      synAckSeq: record.synAckSeq!,
      synRetransmits: record.synRetransmits,
    };
  }
}

/**
 * Default publisher: one line per completed handshake, one aggregate line per
 * sweep. This is what makes the analyser observable before the dashboard bus
 * lands, and it is the output the netem verification greps for.
 */
export function createConsoleHandshakePublisher(
  log: (line: string) => void = (line) => console.log(line),
): HandshakePublisher {
  return {
    publishConnection: (result) => {
      log(
        `handshake ${result.connectionId} ` +
          `syn→synack=${result.synToSynAckMs}ms ` +
          `synack→ack=${result.synAckToAckMs}ms ` +
          `total=${result.totalMs}ms ` +
          `rtt≈${result.rttEstimateMs.toFixed(1)}ms ` +
          `retrans=${result.synRetransmits}`,
      );
    },
    publishAggregate: (snapshot) => {
      // Nothing captured yet (or capture is disabled): stay quiet rather than
      // printing an empty line every second.
      if (snapshot.completedCount === 0 && snapshot.inProgressCount === 0) return;
      const rtt = snapshot.rttEstimateMs;
      const rttText =
        rtt === null
          ? 'rtt=n/a'
          : `rtt p50=${rtt.p50.toFixed(1)} p95=${rtt.p95.toFixed(1)} p99=${rtt.p99.toFixed(1)} max=${rtt.max.toFixed(1)}`;
      log(
        `handshake-aggregate completed=${snapshot.completedCount} ` +
          `inProgress=${snapshot.inProgressCount} stale=${snapshot.staleCount} ` +
          `${rttText}`,
      );
    },
  };
}
