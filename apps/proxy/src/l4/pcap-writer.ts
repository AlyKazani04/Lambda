import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';

import type { CapturedPacket } from './capture.js';

export interface PcapWriterOptions {
  path?: string;
  snaplen?: number;
  linkType?: number;
  log?: (line: string) => void;
}

const DEFAULT_SNAPLEN = 65535;
const DEFAULT_LINK_TYPE = 1; // LINKTYPE_ETHERNET

export class PcapWriter {
  private readonly stream: WriteStream;
  private readonly path: string;
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(options: PcapWriterOptions = {}) {
    this.path = options.path ?? 'capture.pcap';
    this.log = options.log ?? ((line: string) => console.log(line));
    const snaplen = options.snaplen ?? DEFAULT_SNAPLEN;
    const linkType = options.linkType ?? DEFAULT_LINK_TYPE;

    this.stream = createWriteStream(this.path, { flags: 'w' });

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

    const inclLen = Math.min(packet.bytes.length, packet.capturedLength || packet.bytes.length);
    const origLen = packet.originalLength || packet.bytes.length;

    // Split the ms timestamp into seconds + microseconds.
    const totalMs = packet.timestamp;
    const tsSec = Math.floor(totalMs / 1000);
    const tsUsec = (totalMs % 1000) * 1000;

    // Per-packet header — exactly 16 bytes.
    const header = Buffer.alloc(16);
    header.writeUInt32LE(tsSec, 0);
    header.writeUInt32LE(tsUsec, 4);
    header.writeUInt32LE(inclLen, 8);
    header.writeUInt32LE(origLen, 12);

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
