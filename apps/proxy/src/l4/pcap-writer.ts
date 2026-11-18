import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';

import type { LinkType } from '@audc/pcap';

import type { CapturedPacket } from './capture.js';

export interface PcapWriterOptions {
  path?: string;
  snaplen?: number;
  linkType?: number;
  log?: (line: string) => void;
}

const DEFAULT_SNAPLEN = 65535;
const DEFAULT_LINK_TYPE = 1; // LINKTYPE_ETHERNET

/**
 * libpcap link type names -> the numeric values in the pcap global header.
 * The Record type is deliberate: adding a LinkType to @audc/pcap breaks the
 * build here instead of silently falling back to Ethernet. Radiotap (127) is
 * the one that matters most — the capture NIC in this project is WiFi.
 */
const LINK_TYPE_VALUES: Record<LinkType, number> = {
  LINKTYPE_NULL: 0,
  LINKTYPE_ETHERNET: 1,
  LINKTYPE_RAW: 101,
  LINKTYPE_LINUX_SLL: 113,
  LINKTYPE_IEEE802_11_RADIO: 127,
};

export function linkTypeToPcap(linkType: LinkType): number {
  return LINK_TYPE_VALUES[linkType] ?? DEFAULT_LINK_TYPE;
}

export class PcapWriter {
  private readonly stream: WriteStream;
  private readonly path: string;
  private readonly snaplen: number;
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(options: PcapWriterOptions = {}) {
    this.path = options.path ?? 'capture.pcap';
    this.snaplen = options.snaplen ?? DEFAULT_SNAPLEN;
    this.log = options.log ?? ((line: string) => console.log(line));
    const snaplen = this.snaplen;
    const linkType = options.linkType ?? DEFAULT_LINK_TYPE;

    this.stream = createWriteStream(this.path, { flags: 'w' });

    this.stream.on('error', (error: NodeJS.ErrnoException) => {
      this.closed = true;
      this.log(`pcap writer error: ${error.message}`);
    });

    // Global header — exactly 24 bytes.
    const globalHeader = Buffer.alloc(24);
    globalHeader.writeUInt32LE(0xa1b2c3d4, 0); // magic (little-endian variant)
    globalHeader.writeUInt16LE(2, 4); // version major
    globalHeader.writeUInt16LE(4, 6); // version minor
    globalHeader.writeUInt32LE(0, 8); // thiszone
    globalHeader.writeUInt32LE(0, 12); // sigfigs
    globalHeader.writeUInt32LE(snaplen, 16); // snaplen
    globalHeader.writeUInt32LE(linkType, 20); // network (link-layer type)

    this.stream.write(globalHeader);
    this.log(`pcap writer opened path=${this.path} snaplen=${snaplen} linkType=${linkType}`);
  }

  write(packet: CapturedPacket): void {
    if (this.closed) return;

    const inclLen = Math.min(
      packet.bytes.length,
      packet.capturedLength || packet.bytes.length,
      this.snaplen,
    );
    const origLen = packet.originalLength || packet.bytes.length;

    // Prefer the exact capture microseconds. Deriving them from the ms field
    // rounds every timestamp to a multiple of 1000 and makes spot-checks
    // against tshark disagree on sub-millisecond timing.
    const totalUsec = packet.timestampUsec ?? Math.round(packet.timestamp * 1000);
    const tsSec = Math.floor(totalUsec / 1_000_000);
    const tsUsec = totalUsec - tsSec * 1_000_000;

    // Per-packet header — exactly 16 bytes.
    const header = Buffer.alloc(16);
    header.writeUInt32LE(tsSec, 0);
    header.writeUInt32LE(tsUsec, 4);
    header.writeUInt32LE(inclLen, 8);
    header.writeUInt32LE(origLen, 12);

    if (this.closed) return;
    this.stream.write(header);
    if (inclLen > 0) {
      this.stream.write(packet.bytes.subarray(0, inclLen));
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      this.stream.end(() => {
        this.log(`pcap writer closed path=${this.path}`);
        resolve();
      });
    });
  }
}

export function createPcapWriter(options?: PcapWriterOptions): PcapWriter {
  return new PcapWriter(options);
}
