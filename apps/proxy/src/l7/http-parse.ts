import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';

/** Case-insensitive comma-separated tokens, e.g. the Connection header. */
export function headerTokens(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
}

/**
 * True when the client asked to close the connection after this exchange.
 * HTTP/1.0 closes by default; 1.1 keeps the connection alive unless told
 * otherwise.
 */
export function clientWantsClose(req: IncomingMessage): boolean {
  const tokens = headerTokens(req.headers.connection);
  if (tokens.includes('close')) return true;
  if (req.httpVersion === '1.0') return !tokens.includes('keep-alive');
  return false;
}

/** True when the upstream response says to close the connection. */
export function responseWantsClose(headers: IncomingHttpHeaders): boolean {
  return headerTokens(headers.connection).includes('close');
}

/** Statuses that never carry a body, whatever Content-Length claims. */
export function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 304 || (status >= 100 && status < 200);
}

/**
 * HEAD and bodyless statuses (204, 304, 1xx) must not get a Content-Length or
 * Transfer-Encoding. The header would describe a body that is not sent, and
 * the client waits for it. 304 is the classic case: it may legitimately carry
 * the Content-Length of the body it *would* have sent.
 */
export function stripBodylessHeaders(
  headers: OutgoingHttpHeaders,
  status: number,
  method: string,
): OutgoingHttpHeaders {
  if (method !== 'HEAD' && !isBodylessStatus(status)) return headers;

  const copy: OutgoingHttpHeaders = { ...headers };
  for (const name of Object.keys(copy)) {
    const lower = name.toLowerCase();
    if (lower === 'content-length' || lower === 'transfer-encoding') {
      delete copy[name];
    }
  }
  return copy;
}
