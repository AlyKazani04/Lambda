import type { ParsedPacket, TcpFlags, TcpMetadataEvent } from 'shared-types';

const FLAG_ORDER: Array<[keyof TcpFlags, string]> = [
  ['fin', 'FIN'],
  ['syn', 'SYN'],
  ['rst', 'RST'],
  ['psh', 'PSH'],
  ['ack', 'ACK'],
  ['urg', 'URG'],
  ['ece', 'ECE'],
  ['cwr', 'CWR'],
  ['ns', 'NS'],
];

/** Human-readable flag list (e.g. `SYN,ACK`) for the dashboard's TCP table. */
export function formatTcpFlags(flags: TcpFlags): string {
  const active = FLAG_ORDER.filter(([key]) => flags[key] === true).map(([, label]) => label);
  return active.length === 0 ? '-' : active.join(',');
}

/**
 * Map a parsed L4 packet onto the TCP metadata contract shared with the
 * dashboard. Kept pure so the proxy↔dashboard payload shape can be tested
 * without a live capture or Redis connection.
 */
export function toTcpMetadataEvent(packet: ParsedPacket): TcpMetadataEvent {
  const { fiveTuple, tcp, timestamp } = packet;
  return {
    timestamp,
    src: fiveTuple.srcIp,
    dst: fiveTuple.dstIp,
    srcPort: fiveTuple.srcPort,
    dstPort: fiveTuple.dstPort,
    flags: formatTcpFlags(tcp.flags),
    seq: tcp.seq,
    ack: tcp.ack,
    window: tcp.window,
    options: {
      windowScale: tcp.options.windowScale ?? 0,
      mss: tcp.options.mss,
      sackPermitted: tcp.options.sackPermitted,
      sackBlocks: tcp.options.sackBlocks,
      timestamps: tcp.options.timestamps,
    },
  };
}
