import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Honour an inbound X-Request-ID; generate one when absent. Node lowercases
 * header names, so this matches any casing the client sent.
 */
export function resolveTraceId(req: IncomingMessage): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(inbound) ? inbound[0] : inbound;
  return value !== undefined && value.trim() !== '' ? value.trim() : randomUUID();
}
