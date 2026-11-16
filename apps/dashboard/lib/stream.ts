import type { FrameEvent, TcpMetadataEvent } from 'shared-types';

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
