export interface EthernetHeader {
  dstMac: string;
  srcMac: string;
  etherType: number;
}

export interface Ipv4Header {
  version: number;
  ihl: number;
  totalLength: number;
  identification: number;
  flags: number;
  fragmentOffset: number;
  ttl: number;
  protocol: number;
  srcIp: string;
  dstIp: string;
}

export interface TcpFlags {
  fin: boolean;
  syn: boolean;
  rst: boolean;
  psh: boolean;
  ack: boolean;
  urg: boolean;
  ece: boolean;
  cwr: boolean;
  ns: boolean;
  raw: number;
}

export interface SackBlock {
  left: number;
  right: number;
}

export interface TcpTimestamps {
  tsVal: number;
  tsEcr: number;
}

export interface TcpOptions {
  mss?: number;
  windowScale?: number;
  sackPermitted: boolean;
  sackBlocks: SackBlock[];
  timestamps?: TcpTimestamps;
  unknown: Array<{ kind: number; length: number; data: Uint8Array }>;
}

export interface TcpHeader {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  dataOffset: number;
  flags: TcpFlags;
  window: number;
  checksum: number;
  urgentPointer: number;
  options: TcpOptions;
}

export interface FiveTuple {
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  protocol: number;
}

export interface ParsedPacket {
  timestamp: number;
  capturedLength: number;
  originalLength: number;
  linkType: number;
  ethernet: EthernetHeader;
  ipv4: Ipv4Header;
  tcp: TcpHeader;
  payload: Uint8Array;
  fiveTuple: FiveTuple;
}

export interface RawPacketInput {
  bytes: Uint8Array;
  timestamp?: number;
  capturedLength?: number;
  originalLength?: number;
  linkType?: number | string;
}

export function seqDiff(a: number, b: number): number {
  return ((a - b) | 0);
}

export function seqLess(a: number, b: number): boolean {
  return seqDiff(a, b) < 0;
}

export function scaledWindow(tcp: TcpHeader): number {
  const scale = tcp.options.windowScale ?? 0;
  return tcp.window * (1 << scale);
}

/** One TCP metadata event as published to the dashboard's `tcp` channel. */
export interface TcpMetadataEvent {
  timestamp: number;
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  flags: string;
  seq: number;
  ack: number;
  window: number;
  options?: Record<string, unknown>;
}
