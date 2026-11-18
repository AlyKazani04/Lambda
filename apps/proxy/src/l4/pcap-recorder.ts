// B9: owns the live .pcap file for the capture path.
//
// The proxy writes continuously, but an export has to hand the browser a file
// that is complete at the moment of the click. Snapshotting closes and flushes
// the current writer, reads the bytes, then opens a fresh file so capture
// continues without a gap in the *exported* file. Packets arriving during the
// snapshot are queued and written to the new file afterwards.

import { readFile } from 'node:fs/promises';

import type { CapturedPacket } from './capture.js';
import { createPcapWriter, linkTypeToPcap, type PcapWriter } from './pcap-writer.js';

export interface PcapRecorderOptions {
  path: string;
  snaplen?: number;
  log?: (line: string) => void;
}

export class PcapRecorder {
  private readonly path: string;
  private readonly snaplen: number = 65_535;
  private readonly log: (line: string) => void;
  private writer: PcapWriter | null = null;
  private linkTypeValue: number | null = null;
  private pending: CapturedPacket[] = [];
  private snapshotting = false;
  private closed = false;
  private count = 0;
  // Serializes snapshots so overlapping calls can't close/truncate the same
  // file out from under each other. Always resolves, even after a failure.
  private chain: Promise<void> = Promise.resolve();

  constructor(options: PcapRecorderOptions) {
    this.path = options.path;
    this.snaplen = options.snaplen ?? this.snaplen;
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  get packetCount(): number {
    return this.count;
  }

  observe(packet: CapturedPacket): void {
    this.count += 1;
    if (this.closed) return;
    this.linkTypeValue ??= linkTypeToPcap(packet.linkType);

    if (this.snapshotting) {
      this.pending.push(packet);
      return;
    }
    this.ensureWriter().write(packet);
  }

  /** Return a complete .pcap, or null when nothing has been captured yet. */
  snapshot(): Promise<Buffer | null> {
    // Queue every call behind the previous one. Two overlapping snapshots
    // would otherwise both close and read the same path, and the first one's
    // finally would reopen it with flags:'w' and truncate the second's read.
    const result = this.chain.then(() => this.performSnapshot());
    // Advance the chain on both success and failure so a single rejected
    // snapshot cannot poison every later call.
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async performSnapshot(): Promise<Buffer | null> {
    if (this.writer === null && this.pending.length === 0) return null;

    this.snapshotting = true;
    try {
      await this.writer?.close();
      this.writer = null;
      try {
        return await readFile(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    } finally {
      // Reopen even when the read failed: capture must never stop because an
      // export hit a transient filesystem error.
      this.writer = this.ensureWriter();
      this.snapshotting = false;
      const queued = this.pending;
      this.pending = [];
      for (const packet of queued) this.writer.write(packet);
      this.log(
        `pcap snapshot path=${this.path} packets=${this.count} queued=${queued.length}`,
      );
    }
  }

  /** Flush on shutdown so an interrupted run still leaves a readable file. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer?.close();
    this.writer = null;
  }

  private ensureWriter(): PcapWriter {
    if (this.writer === null) {
      this.writer = createPcapWriter({
        path: this.path,
        snaplen: this.snaplen,
        linkType: this.linkTypeValue ?? 1,
        log: this.log,
      });
    }
    return this.writer;
  }
}
