// B6 — TCP connection state per canonical 5-tuple.

import type { ParsedPacket } from 'shared-types';

export type ConnectionState =
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSING'
  | 'CLOSE_WAIT'
  | 'LAST_ACK'
  | 'TIME_WAIT';

export interface ConnectionView {
  client: string;
  server: string;
  clientState: ConnectionState | null;
  serverState: ConnectionState | null;
  rstCount: number;
}

export interface ConnectionStateEvent {
  connectionId: string;
  client: string;
  server: string;
  side: 'client' | 'server';
  state: ConnectionState | 'CLOSED';
  timestamp: number;
  rstCount: number;
  traceId?: string;
  path?: string;
  illegal?: boolean;
}

export interface StateMachineOptions {
  staleAfterMs?: number;
  timeWaitMs?: number;
  maxHistory?: number;
  maxConnections?: number;
  now?: () => number;
  publish?: (event: ConnectionStateEvent) => void;
  onIllegal?: (line: string) => void;
}

interface Endpoint {
  ip: string;
  port: number;
}

interface SideState {
  state: ConnectionState;
  enteredAt: number;
}

interface Connection {
  client: Endpoint;
  server: Endpoint;
  clientState: SideState | null;
  serverState: SideState | null;
  lastSeen: number;
  rstCount: number;
}

interface TraceInfo {
  traceId: string;
  path?: string;
}

type Flags = { syn: boolean; ack: boolean; fin: boolean };

const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_TIME_WAIT_MS = 120_000; // 2 × MSL
const DEFAULT_MAX_HISTORY = 1_000;
const DEFAULT_MAX_CONNECTIONS = 10_000;

function endpointKey(endpoint: Endpoint): string {
  return `${endpoint.ip}:${endpoint.port}`;
}

// Sorting the endpoint pair makes the key direction-insensitive: the SYN and
// the SYN-ACK of one connection land on the same record.
function connectionKey(a: Endpoint, b: Endpoint): string {
  const left = endpointKey(a);
  const right = endpointKey(b);
  return left <= right ? `${left}|${right}` : `${right}|${left}`;
}

function ageOf(side: SideState | null, connection: Connection, now: number): number {
  if (side === null) return now - connection.lastSeen;
  return now - (side.state === 'TIME_WAIT' ? side.enteredAt : connection.lastSeen);
}

// A packet advances the sending endpoint and the receiving endpoint differently.
// The same FIN means FIN_WAIT_1 to its sender and CLOSE_WAIT to its receiver.
function senderTransition(state: ConnectionState, flags: Flags): ConnectionState | null {
  switch (state) {
    case 'ESTABLISHED':
      return flags.fin ? 'FIN_WAIT_1' : state;
    case 'FIN_WAIT_1':
      return state; // retransmitted FIN is a no-op
    case 'CLOSE_WAIT':
      return flags.fin ? 'LAST_ACK' : state;
    case 'CLOSING':
      return flags.ack ? 'TIME_WAIT' : state;
    default:
      return state;
  }
}

function receiverTransition(state: ConnectionState, flags: Flags): ConnectionState | null {
  switch (state) {
    case 'SYN_SENT':
      return flags.syn && flags.ack ? 'ESTABLISHED' : state;
    case 'SYN_RCVD':
      return flags.ack && !flags.syn && !flags.fin ? 'ESTABLISHED' : state;
    case 'ESTABLISHED':
      return flags.fin ? 'CLOSE_WAIT' : state;
    case 'FIN_WAIT_1':
      if (flags.fin && flags.ack) return 'TIME_WAIT';
      if (flags.fin) return 'CLOSING';
      if (flags.ack) return 'FIN_WAIT_2';
      return state;
    case 'FIN_WAIT_2':
      return flags.fin ? 'TIME_WAIT' : state;
    case 'CLOSING':
      return flags.ack ? 'TIME_WAIT' : state;
    case 'CLOSE_WAIT':
      return state;
    case 'LAST_ACK':
      return flags.ack ? null : state;
    case 'TIME_WAIT':
      return state;
    default:
      return state;
  }
}

export class TcpStateMachine {
  private readonly connections = new Map<string, Connection>();
  private readonly traces = new Map<string, TraceInfo>();
  private readonly history: ConnectionStateEvent[] = [];
  private readonly staleAfterMs: number;
  private readonly timeWaitMs: number;
  private readonly maxHistory: number;
  private readonly maxConnections: number;
  private readonly now: () => number;
  private readonly publish: (event: ConnectionStateEvent) => void;
  private readonly onIllegal: (line: string) => void;
  private totalRst = 0;
  private totalIllegal = 0;

  constructor(options: StateMachineOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.timeWaitMs = options.timeWaitMs ?? DEFAULT_TIME_WAIT_MS;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.now = options.now ?? (() => Date.now());
    this.publish = options.publish ?? (() => {});
    this.onIllegal = options.onIllegal ?? (() => {});
  }

  associateTrace(ip: string, port: number, traceId: string, path?: string): void {
    this.traces.set(`${ip}:${port}`, { traceId, path });
    if (this.traces.size > this.maxConnections) {
      const oldest = this.traces.keys().next().value;
      if (oldest !== undefined) this.traces.delete(oldest);
    }
  }

  observe(packet: ParsedPacket): void {
    const { fiveTuple, tcp, timestamp } = packet;
    const src: Endpoint = { ip: fiveTuple.srcIp, port: fiveTuple.srcPort };
    const dst: Endpoint = { ip: fiveTuple.dstIp, port: fiveTuple.dstPort };
    const key = connectionKey(src, dst);
    const flags: Flags = { syn: tcp.flags.syn, ack: tcp.flags.ack, fin: tcp.flags.fin };

    const connection = this.connections.get(key);

    if (tcp.flags.rst) {
      if (connection !== undefined) {
        this.totalRst += 1;
        connection.rstCount += 1;
        this.closeSides(connection, key, timestamp);
        this.connections.delete(key);
      }
      return;
    }

    if (connection === undefined) {
      if (!flags.syn) return;
      const client = flags.ack ? dst : src;
      const server = flags.ack ? src : dst;
      const record: Connection = {
        client,
        server,
        clientState: { state: flags.ack ? 'ESTABLISHED' : 'SYN_SENT', enteredAt: timestamp },
        serverState: { state: 'SYN_RCVD', enteredAt: timestamp },
        lastSeen: timestamp,
        rstCount: 0,
      };
      this.connections.set(key, record);
      this.emit(record, key, 'client', record.clientState!.state, timestamp);
      this.emit(record, key, 'server', record.serverState!.state, timestamp);
      this.enforceCap(timestamp);
      return;
    }

    connection.lastSeen = timestamp;
    const fromClient = endpointKey(src) === endpointKey(connection.client);
    const senderSide = fromClient ? 'client' : 'server';
    const receiverSide = fromClient ? 'server' : 'client';

    const senderState = connection[senderSide === 'client' ? 'clientState' : 'serverState'];
    if (senderState !== null && senderState.state !== 'SYN_SENT' && flags.syn && !flags.ack && !flags.fin) {
      this.logIllegal(key, senderSide, timestamp);
    }

    this.advance(connection, key, senderSide, senderTransition, flags, timestamp);
    this.advance(connection, key, receiverSide, receiverTransition, flags, timestamp);
  }

  sweep(now: number = this.now()): number {
    let removed = 0;
    for (const [key, connection] of this.connections) {
      const inTimeWait =
        connection.clientState?.state === 'TIME_WAIT' ||
        connection.serverState?.state === 'TIME_WAIT';
      const limit = inTimeWait ? this.timeWaitMs : this.staleAfterMs;
      const elapsed = Math.max(
        ageOf(connection.clientState, connection, now),
        ageOf(connection.serverState, connection, now),
      );
      if (elapsed <= limit) continue;
      this.closeSides(connection, key, now);
      this.connections.delete(key);
      removed += 1;
    }
    return removed;
  }

  states(): Map<string, ConnectionView> {
    const result = new Map<string, ConnectionView>();
    for (const [key, connection] of this.connections) {
      result.set(key, {
        client: endpointKey(connection.client),
        server: endpointKey(connection.server),
        clientState: connection.clientState?.state ?? null,
        serverState: connection.serverState?.state ?? null,
        rstCount: connection.rstCount,
      });
    }
    return result;
  }

  recent(): readonly ConnectionStateEvent[] {
    return this.history;
  }

  get rstCount(): number {
    return this.totalRst;
  }

  get illegalCount(): number {
    return this.totalIllegal;
  }

  get size(): number {
    return this.connections.size;
  }

  private advance(
    connection: Connection,
    key: string,
    side: 'client' | 'server',
    step: (state: ConnectionState, flags: Flags) => ConnectionState | null,
    flags: Flags,
    timestamp: number,
  ): void {
    const field = side === 'client' ? 'clientState' : 'serverState';
    const current = connection[field];
    if (current === null) return;
    const next = step(current.state, flags);
    if (next === current.state) return;
    if (next === null) {
      connection[field] = null;
      this.emit(connection, key, side, 'CLOSED', timestamp);
      return;
    }
    connection[field] = { state: next, enteredAt: timestamp };
    this.emit(connection, key, side, next, timestamp);
  }

  private logIllegal(key: string, side: 'client' | 'server', timestamp: number): void {
    this.totalIllegal += 1;
    this.onIllegal(`illegal transition connection=${key} side=${side} t=${timestamp}`);
  }

  private closeSides(connection: Connection, key: string, timestamp: number): void {
    if (connection.clientState !== null) {
      this.emit(connection, key, 'client', 'CLOSED', timestamp);
      connection.clientState = null;
    }
    if (connection.serverState !== null) {
      this.emit(connection, key, 'server', 'CLOSED', timestamp);
      connection.serverState = null;
    }
  }

  private enforceCap(timestamp: number): void {
    while (this.connections.size > this.maxConnections) {
      let oldestKey: string | undefined;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [key, connection] of this.connections) {
        if (connection.lastSeen < oldestSeen) {
          oldestSeen = connection.lastSeen;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      const connection = this.connections.get(oldestKey)!;
      this.closeSides(connection, oldestKey, timestamp);
      this.connections.delete(oldestKey);
    }
  }

  private emit(
    connection: Connection,
    key: string,
    side: 'client' | 'server',
    state: ConnectionState | 'CLOSED',
    timestamp: number,
  ): void {
    const endpoint = side === 'client' ? connection.client : connection.server;
    const trace = this.traces.get(endpointKey(endpoint));
    const event: ConnectionStateEvent = {
      connectionId: key,
      client: endpointKey(connection.client),
      server: endpointKey(connection.server),
      side,
      state,
      timestamp,
      rstCount: connection.rstCount,
      ...(trace === undefined ? {} : { traceId: trace.traceId, path: trace.path }),
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.publish(event);
  }
}
