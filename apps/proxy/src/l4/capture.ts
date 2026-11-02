import { createSession } from '@audc/pcap';
import type { LinkType, PcapSession } from '@audc/pcap';

export interface CapturedPacket {
  bytes: Buffer;
  timestamp: number;
  capturedLength: number;
  originalLength: number;
  linkType: LinkType;
}

export interface CaptureHandle {
  readonly iface: string;
  readonly filter: string;
  started: boolean;
  packetsReceived: number;
  lastPacketsPerSecond: number;
  stop: () => void;
}

export interface CaptureOptions {
  iface?: string;
  filter?: string;
  proxyPort?: number;
  snaplen?: number;
  bufferSize?: number;
  bufferTimeoutMs?: number;
  promiscuous?: boolean;
  onPacket: (packet: CapturedPacket) => void;
  onError?: (error: Error) => void;
  onStats?: (packetsPerSecond: number) => void;
  log?: (line: string) => void;
}

export const DEFAULT_CAPTURE_SNAPLEN = 65535;
export const DEFAULT_CAPTURE_BUFFER_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CAPTURE_BUFFER_TIMEOUT_MS = 100;

function readProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PROXY_PORT;
  if (raw === undefined || raw.trim() === '') return 8080;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return 8080;
  return value;
}

export function startCapture(options: CaptureOptions): CaptureHandle {
  const log = options.log ?? ((line: string) => console.log(line));
  const onError = (error: Error): void => {
    options.onError?.(error);
    console.error(`capture error: ${error.message}`);
  };

  const iface = (options.iface ?? process.env.CAPTURE_IFACE ?? '').trim();
  if (iface === '') {
    const error = new Error('CAPTURE_IFACE is not set; capture disabled');
    onError(error);
    return {
      iface: '',
      filter: '',
      started: false,
      packetsReceived: 0,
      lastPacketsPerSecond: 0,
      stop: () => { },
    };
  }

  if (iface === 'lo') {
    console.warn(
      "capture: interface is 'lo'. This usually means capture is namespace-isolated " +
      'and will see no host traffic. Set CAPTURE_IFACE to the physical NIC.',
    );
  }

  const proxyPort = options.proxyPort ?? readProxyPort();
  const filter = (options.filter ?? process.env.CAPTURE_FILTER ?? `tcp port ${proxyPort}`).trim();
  const snaplen = options.snaplen ?? DEFAULT_CAPTURE_SNAPLEN;
  const bufferSize = options.bufferSize ?? DEFAULT_CAPTURE_BUFFER_BYTES;
  const bufferTimeoutMs = options.bufferTimeoutMs ?? DEFAULT_CAPTURE_BUFFER_TIMEOUT_MS;
  const promiscuous = options.promiscuous ?? false;

  const handle: CaptureHandle = {
    iface,
    filter,
    started: false,
    packetsReceived: 0,
    lastPacketsPerSecond: 0,
    stop: () => { },
  };

  let session: PcapSession | null = null;
  try {
    session = createSession(iface, {
      filter,
      buffer_size: bufferSize,
      snap_length: snaplen,
      promiscuous,
      buffer_timeout: bufferTimeoutMs,
    });
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return handle;
  }

  handle.started = true;

  let windowCount = 0;

  session.on('packet', (raw: { buf: Buffer; header: Buffer; link_type: LinkType }) => {
    try {
      const header = raw.header;
      const capturedLength = header.readUInt32LE(8);
      const originalLength = header.readUInt32LE(12);
      const sec = header.readUInt32LE(0);
      const usec = header.readUInt32LE(4);
      const bytes = Buffer.from(raw.buf.subarray(0, capturedLength));

      const packet: CapturedPacket = {
        bytes,
        timestamp: sec * 1000 + Math.floor(usec / 1000),
        capturedLength,
        originalLength,
        linkType: raw.link_type,
      };

      handle.packetsReceived += 1;
      windowCount += 1;
      options.onPacket(packet);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });

  session.on('error', (error: unknown) => {
    onError(error instanceof Error ? error : new Error(String(error)));
  });

  const ppsTimer = setInterval(() => {
    const pps = windowCount;
    windowCount = 0;
    handle.lastPacketsPerSecond = pps;
    log(`capture iface=${iface} filter="${filter}" pps=${pps} total=${handle.packetsReceived}`);
    options.onStats?.(pps);
    if (pps === 0) {
      console.warn(`capture: pps=0 on ${iface} - capture may be silent (check interface/network mode)`);
    }
  }, 1000);

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(ppsTimer);
    try {
      session?.close();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
    log(`capture stopped iface=${iface} total=${handle.packetsReceived}`);
  };
  handle.stop = stop;

  return handle;
}
