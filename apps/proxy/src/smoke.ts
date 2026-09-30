// Smoke test — proves libpcap capture actually works on this machine.
//
// This is the project's first gate. If it cannot capture packets, nothing else
// matters, so it exits non-zero on failure so CI and scripts can depend on it.
//
// Usage:
// CAPTURE_IFACE=lo pnpm smoke
//
// Note: capturing a live interface requires CAP_NET_RAW (root, or Docker
// with NET_ADMIN). Without it, libpcap fails to open the device and this
// script exits 1 with a clear message rather than a cryptic errno.

import pcap from '@audc/pcap';

const iface = process.env.CAPTURE_IFACE ?? 'lo';
const DURATION_MS = Number(process.env.SMOKE_DURATION_MS ?? 5000);

console.log(`libpcap version: ${pcap.lib_version}`);
console.log(`capturing on "${iface}" for ${DURATION_MS}ms ...`);

let packets = 0;
let bytes = 0;
let session: pcap.PcapSession;

try {
  session = pcap.createSession(iface, { filter: 'ip proto \\tcp' });
} catch (err) {
  console.error(`\nFAILED to open capture on "${iface}"`);
  console.error(`  ${(err as Error).message}`);
  console.error(
    '\nMost likely cause: missing CAP_NET_RAW.\n' +
    '  - run as root, or\n' +
    '  - run in Docker with cap_add: [NET_ADMIN], or\n' +
    '  - grant: sudo setcap cap_net_raw,cap_net_admin=eip $(which node)',
  );
  process.exit(1);
}

session.on('packet', (packet: pcap.PacketWithHeader) => {
  packets += 1;
  bytes += packet.buf.length;
});

const timer = setTimeout(() => {
  session.close();
  const stats = session.stats();

  console.log('\n--- results ---');
  console.log(`packets captured : ${packets}`);
  console.log(`bytes captured   : ${bytes}`);
  console.log(`kernel ps_recv   : ${stats.ps_recv}`);
  console.log(`dropped (iface)  : ${stats.ps_ifdrop}`);
  console.log(`dropped (buffer) : ${stats.ps_drop}`);
  console.log(`link type        : ${session.link_type}`);

  if (packets === 0) {
    console.error('\nFAILED: opened the interface but saw no TCP traffic.');
    console.error('The device is live. Generate traffic and retry:');
    console.error('  (another terminal)  ping -c 3 1.1.1.1');
    console.error('  or narrow the filter if you only expect loopback traffic.');
    process.exit(1);
  }

  console.log('\nOK: capture is working.');
  process.exit(0);
}, DURATION_MS);

// Hold a reference so the timer is not garbage-collected before it fires, and
// so an early exit (e.g. SIGINT) can clear it cleanly.
const shutdown = () => {
  clearTimeout(timer);
  try {
    session.close();
  } catch {
    /* already closed */
  }
  process.exit(130);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
