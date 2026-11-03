import type {
  EthernetHeader,
  FiveTuple,
  Ipv4Header,
  ParsedPacket,
  RawPacketInput,
  SackBlock,
  TcpFlags,
  TcpHeader,
  TcpOptions,
  TcpTimestamps,
} from 'shared-types';

const ETHERNET_HEADER_LEN = 14;
const ETHERTYPE_IPV4 = 0x0800;
const IP_PROTOCOL_TCP = 6;

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function formatMac(bytes: Uint8Array, offset: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push(bytes[offset + i]!.toString(16).padStart(2, '0'));
  }
  return parts.join(':');
}

function formatIp(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]!}.${bytes[offset + 1]!}.${bytes[offset + 2]!}.${bytes[offset + 3]!}`;
}

export function parsePacket(input: RawPacketInput): ParsedPacket | null {
  const bytes = input.bytes;
  const timestamp = input.timestamp ?? 0;
  const capturedLength = input.capturedLength ?? bytes.length;
  const originalLength = input.originalLength ?? bytes.length;
  const linkTypeRaw = input.linkType ?? 1;
  const linkType =
    typeof linkTypeRaw === 'string'
      ? linkTypeRaw === 'LINKTYPE_ETHERNET'
        ? 1
        : 0
      : linkTypeRaw;

  // Ethernet header (14 bytes).
  if (bytes.length < ETHERNET_HEADER_LEN) return null;

  const etherType = readUint16BE(bytes, 12);
  if (etherType !== ETHERTYPE_IPV4) return null;

  const ethernet: EthernetHeader = {
    dstMac: formatMac(bytes, 0),
    srcMac: formatMac(bytes, 6),
    etherType,
  };

  // IPv4 header.
  const ipOffset = ETHERNET_HEADER_LEN;
  if (bytes.length < ipOffset + 20) return null;

  const versionAndIhl = bytes[ipOffset]!;
  const version = (versionAndIhl >> 4) & 0x0f;
  const ihl = versionAndIhl & 0x0f;
  if (version !== 4) return null;
  if (ihl < 5) return null;

  const ipHeaderLen = ihl * 4;
  if (bytes.length < ipOffset + ipHeaderLen) return null;

  const totalLength = readUint16BE(bytes, ipOffset + 2);
  const protocol = bytes[ipOffset + 9]!;
  if (protocol !== IP_PROTOCOL_TCP) return null;

  const ipv4: Ipv4Header = {
    version,
    ihl,
    totalLength,
    identification: readUint16BE(bytes, ipOffset + 4),
    flags: (bytes[ipOffset + 6]! >> 5) & 0x07,
    fragmentOffset: readUint16BE(bytes, ipOffset + 6) & 0x1fff,
    ttl: bytes[ipOffset + 8]!,
    protocol,
    srcIp: formatIp(bytes, ipOffset + 12),
    dstIp: formatIp(bytes, ipOffset + 16),
  };

  // TCP header.
  const tcpOffset = ipOffset + ipHeaderLen;
  if (bytes.length < tcpOffset + 20) return null;

  const srcPort = readUint16BE(bytes, tcpOffset);
  const dstPort = readUint16BE(bytes, tcpOffset + 2);
  const seq = readUint32BE(bytes, tcpOffset + 4);
  const ack = readUint32BE(bytes, tcpOffset + 8);

  const dataOffsetByte = bytes[tcpOffset + 12]!;
  const dataOffset = (dataOffsetByte >> 4) & 0x0f;
  if (dataOffset < 5) return null;
  const tcpHeaderLen = dataOffset * 4;
  if (bytes.length < tcpOffset + tcpHeaderLen) return null;

  const ns = (dataOffsetByte & 0x01) === 1;
  const flagsByte = bytes[tcpOffset + 13]!;
  const flags: TcpFlags = {
    fin: (flagsByte & 0x01) !== 0,
    syn: (flagsByte & 0x02) !== 0,
    rst: (flagsByte & 0x04) !== 0,
    psh: (flagsByte & 0x08) !== 0,
    ack: (flagsByte & 0x10) !== 0,
    urg: (flagsByte & 0x20) !== 0,
    ece: (flagsByte & 0x40) !== 0,
    cwr: (flagsByte & 0x80) !== 0,
    ns,
    raw: (ns ? 0x100 : 0) | flagsByte,
  };

  const window = readUint16BE(bytes, tcpOffset + 14);
  const checksum = readUint16BE(bytes, tcpOffset + 16);
  const urgentPointer = readUint16BE(bytes, tcpOffset + 18);

  // Parse TCP options.
  const options: TcpOptions = {
    sackPermitted: false,
    sackBlocks: [],
    unknown: [],
  };

  const optionsStart = tcpOffset + 20;
  const optionsEnd = tcpOffset + tcpHeaderLen;
  let cursor = optionsStart;
  while (cursor < optionsEnd) {
    const kind = bytes[cursor]!;
    if (kind === 0) break; // EOL
    if (kind === 1) {
      cursor += 1; // NOP
      continue;
    }
    if (cursor + 2 > optionsEnd) break;
    const length = bytes[cursor + 1]!;
    if (length < 2 || cursor + length > optionsEnd) break;

    switch (kind) {
      case 2: // MSS
        if (length >= 4) {
          options.mss = readUint16BE(bytes, cursor + 2);
        }
        break;
      case 3: // Window scale
        if (length >= 3) {
          options.windowScale = bytes[cursor + 2]!;
        }
        break;
      case 4: // SACK permitted
        options.sackPermitted = true;
        break;
      case 5: { // SACK blocks
        let blockCursor = cursor + 2;
        const blockEnd = cursor + length;
        while (blockCursor + 8 <= blockEnd) {
          const left = readUint32BE(bytes, blockCursor);
          const right = readUint32BE(bytes, blockCursor + 4);
          const block: SackBlock = { left, right };
          options.sackBlocks.push(block);
          blockCursor += 8;
        }
        break;
      }
      case 8: // Timestamps
        if (length >= 10) {
          const ts: TcpTimestamps = {
            tsVal: readUint32BE(bytes, cursor + 2),
            tsEcr: readUint32BE(bytes, cursor + 6),
          };
          options.timestamps = ts;
        }
        break;
      default:
        options.unknown.push({
          kind,
          length,
          data: bytes.slice(cursor + 2, cursor + length),
        });
        break;
    }

    cursor += length;
  }

  const tcp: TcpHeader = {
    srcPort,
    dstPort,
    seq,
    ack,
    dataOffset,
    flags,
    window,
    checksum,
    urgentPointer,
    options,
  };

  const payloadStart = tcpOffset + tcpHeaderLen;
  const payload = bytes.slice(payloadStart);

  const fiveTuple: FiveTuple = {
    srcIp: ipv4.srcIp,
    srcPort,
    dstIp: ipv4.dstIp,
    dstPort,
    protocol: ipv4.protocol,
  };

  return {
    timestamp,
    capturedLength,
    originalLength,
    linkType,
    ethernet,
    ipv4,
    tcp,
    payload,
    fiveTuple,
  };
}
