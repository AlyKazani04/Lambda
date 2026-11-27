import type { FrameEvent, RetransmitEvent, SlowlorisEvent, RttEstimateEvent, TcpMetadataEvent, TcpStateEvent } from 'shared-types';

/**
 * WebSocket payloads cross the wire as JSON and may come from a proxy running
 * a different version. Validate the fields the UI actually renders instead of
 * casting blindly, so a shape mismatch degrades to "skip this row" rather than
 * crashing the dashboard with a `toFixed()` on undefined.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string';
}

export function parseFrameEvent(payload: unknown): FrameEvent | null {
  if (!isRecord(payload)) return null;
  if (
    !hasString(payload, 'traceId') ||
    !hasString(payload, 'hop') ||
    !hasString(payload, 'method') ||
    !hasString(payload, 'path') ||
    !isFiniteNumber(payload['status']) ||
    !isFiniteNumber(payload['requestBytes']) ||
    !isFiniteNumber(payload['responseBytes']) ||
    !isFiniteNumber(payload['durationMs']) ||
    !isFiniteNumber(payload['internalMs'])
  ) {
    return null;
  }
  return {
    traceId: payload['traceId'] as string,
    hop: payload['hop'] as FrameEvent['hop'],
    method: payload['method'] as string,
    path: payload['path'] as string,
    status: payload['status'] as number,
    requestBytes: payload['requestBytes'] as number,
    responseBytes: payload['responseBytes'] as number,
    durationMs: payload['durationMs'] as number,
    internalMs: payload['internalMs'] as number,
    timestamp: isFiniteNumber(payload['timestamp']) ? payload['timestamp'] : 0,
    group: hasString(payload, 'group') ? (payload['group'] as string) : undefined,
    upstream: hasString(payload, 'upstream') ? (payload['upstream'] as string) : undefined,
  };
}

export function parseTcpEvent(payload: unknown): TcpMetadataEvent | null {
  if (!isRecord(payload)) return null;
  if (
    !hasString(payload, 'src') ||
    !hasString(payload, 'dst') ||
    !hasString(payload, 'flags') ||
    !isFiniteNumber(payload['srcPort']) ||
    !isFiniteNumber(payload['dstPort']) ||
    !isFiniteNumber(payload['seq']) ||
    !isFiniteNumber(payload['ack']) ||
    !isFiniteNumber(payload['window'])
  ) {
    return null;
  }
  return {
    timestamp: isFiniteNumber(payload['timestamp']) ? payload['timestamp'] : 0,
    src: payload['src'] as string,
    dst: payload['dst'] as string,
    srcPort: payload['srcPort'] as number,
    dstPort: payload['dstPort'] as number,
    flags: payload['flags'] as string,
    seq: payload['seq'] as number,
    ack: payload['ack'] as number,
    window: payload['window'] as number,
    options: isRecord(payload['options'])
      ? (payload['options'] as TcpMetadataEvent['options'])
      : undefined,
  };
}

export function parseRetransmitEvent(payload: unknown): RetransmitEvent | null {
  if (!isRecord(payload)) return null;
  const kind = payload['kind'];
  const cause = payload['cause'];
  if (
    (kind !== 'full' && kind !== 'partial') ||
    (cause !== 'fast' && cause !== 'timeout') ||
    !hasString(payload, 'connectionId') ||
    !hasString(payload, 'client') ||
    !hasString(payload, 'server') ||
    !hasString(payload, 'from') ||
    !isFiniteNumber(payload['timestamp']) ||
    !isFiniteNumber(payload['seq']) ||
    !isFiniteNumber(payload['length']) ||
    !isFiniteNumber(payload['overlapBytes']) ||
    !isFiniteNumber(payload['delayMs']) ||
    !isNullableFiniteNumber(payload['observedRtoMs']) ||
    !isFiniteNumber(payload['dupAcks']) ||
    !isFiniteNumber(payload['rate']) ||
    !isFiniteNumber(payload['globalRate']) ||
    typeof payload['truncated'] !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: kind as RetransmitEvent['kind'],
    cause: cause as RetransmitEvent['cause'],
    connectionId: payload['connectionId'] as string,
    client: payload['client'] as string,
    server: payload['server'] as string,
    from: payload['from'] as string,
    timestamp: payload['timestamp'] as number,
    seq: payload['seq'] as number,
    length: payload['length'] as number,
    overlapBytes: payload['overlapBytes'] as number,
    delayMs: payload['delayMs'] as number,
    observedRtoMs: payload['observedRtoMs'] as number | null,
    dupAcks: payload['dupAcks'] as number,
    rate: payload['rate'] as number,
    globalRate: payload['globalRate'] as number,
    truncated: payload['truncated'] as boolean,
  };
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

export function parseRttEvent(payload: unknown): RttEstimateEvent | null {
  if (!isRecord(payload)) return null;
  const kind = payload['kind'];
  if (
    (kind !== 'sample' && kind !== 'backoff' && kind !== 'ack') ||
    !hasString(payload, 'connectionId') ||
    !hasString(payload, 'client') ||
    !hasString(payload, 'server') ||
    !isFiniteNumber(payload['timestamp']) ||
    !isNullableFiniteNumber(payload['srttMs']) ||
    !isNullableFiniteNumber(payload['rttvarMs']) ||
    !isNullableFiniteNumber(payload['baseRtoMs']) ||
    !isFiniteNumber(payload['rtoMs']) ||
    typeof payload['backedOff'] !== 'boolean'
  ) {
    return null;
  }

  const rawSample = payload['sample'];
  let sample: RttEstimateEvent['sample'];
  if (rawSample !== undefined) {
    if (
      !isRecord(rawSample) ||
      !isFiniteNumber(rawSample['timestamp']) ||
      !isFiniteNumber(rawSample['rttMs']) ||
      (rawSample['method'] !== 'timestamp' && rawSample['method'] !== 'seq-ack') ||
      !hasString(rawSample, 'from')
    ) {
      return null;
    }
    sample = {
      timestamp: rawSample['timestamp'] as number,
      rttMs: rawSample['rttMs'] as number,
      method: rawSample['method'] as 'timestamp' | 'seq-ack',
      from: rawSample['from'] as string,
    };
  }

  return {
    kind: kind as RttEstimateEvent['kind'],
    connectionId: payload['connectionId'] as string,
    client: payload['client'] as string,
    server: payload['server'] as string,
    timestamp: payload['timestamp'] as number,
    ...(sample === undefined ? {} : { sample }),
    srttMs: payload['srttMs'] as number | null,
    rttvarMs: payload['rttvarMs'] as number | null,
    baseRtoMs: payload['baseRtoMs'] as number | null,
    rtoMs: payload['rtoMs'] as number,
    backedOff: payload['backedOff'] as boolean,
  };
}

export function parseTcpStateEvent(payload: unknown): TcpStateEvent | null {
  if (!isRecord(payload)) return null;
  if (
    !hasString(payload, 'connectionId') ||
    !hasString(payload, 'client') ||
    !hasString(payload, 'server') ||
    !hasString(payload, 'side') ||
    !hasString(payload, 'state') ||
    !isFiniteNumber(payload['timestamp']) ||
    !isFiniteNumber(payload['rstCount'])
  ) {
    return null;
  }
  return {
    connectionId: payload['connectionId'] as string,
    client: payload['client'] as string,
    server: payload['server'] as string,
    side: payload['side'] as string,
    state: payload['state'] as string,
    timestamp: payload['timestamp'] as number,
    rstCount: payload['rstCount'] as number,
    traceId: hasString(payload, 'traceId') ? (payload['traceId'] as string) : undefined,
    path: hasString(payload, 'path') ? (payload['path'] as string) : undefined,
    illegal: payload['illegal'] === true,
  };
}

export function parseSlowlorisEvent(payload: unknown): SlowlorisEvent | null {
  if (!isRecord(payload)) return null;
  const phase = payload['phase'];
  if (
    (phase !== 'ttfb' && phase !== 'headers' && phase !== 'body' && phase !== 'idle') ||
    !hasString(payload, 'reason') ||
    !hasString(payload, 'client') ||
    !isFiniteNumber(payload['elapsedMs']) ||
    !isFiniteNumber(payload['bytesReceived']) ||
    !isFiniteNumber(payload['timestamp'])
  ) {
    return null;
  }
  return {
    phase,
    reason: payload['reason'] as string,
    client: payload['client'] as string,
    elapsedMs: payload['elapsedMs'] as number,
    bytesReceived: payload['bytesReceived'] as number,
    timestamp: payload['timestamp'] as number,
    traceId: hasString(payload, 'traceId') ? (payload['traceId'] as string) : undefined,
    path: hasString(payload, 'path') ? (payload['path'] as string) : undefined,
  };
}
