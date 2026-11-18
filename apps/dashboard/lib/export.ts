// B9: dashboard-side configuration and validation for the capture download.

const DEFAULT_PROXY_EXPORT_URL = 'http://127.0.0.1:8080';

/** Where the dashboard asks for the proxy's capture. No trailing slash. */
export function proxyExportUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (env.PROXY_EXPORT_URL ?? '').trim();
  const base = raw === '' ? DEFAULT_PROXY_EXPORT_URL : raw;
  return base.replace(/\/+$/, '');
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pcap$/;

/**
 * Only forward a download name if it is a bare .pcap filename. The proxy is
 * internal, but a malformed or hostile header must never become a response
 * header on the browser-facing side.
 */
export function safeDownloadFilename(header: string | null): string | null {
  if (header === null) return null;
  const match = /^attachment;\s*filename="([^"]+)"$/.exec(header);
  if (match === null) return null;
  const name = match[1] ?? '';
  return SAFE_FILENAME.test(name) ? name : null;
}
