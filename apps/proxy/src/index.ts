import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadConfig, timeoutBackstopMs } from './config.js';
import { createFrameBus } from './bus/redis.js';
import { toTcpMetadataEvent } from './bus/tcp-event.js';
import { startCapture } from './l4/capture.js';
import { parsePacket } from './l4/packet-parser.js';
import { PcapRecorder } from './l4/pcap-recorder.js';
import { handleExportRequest } from './l4/export-route.js';
import { createConsoleHandshakePublisher, HandshakeAnalyser } from './l4/handshake.js';
import { TcpStateMachine } from './l4/state-machine.js';
import { RttAnalyser } from './l4/rtt.js';
import { RetransmitAnalyser } from './l4/retransmit.js';
import { forward } from './forwarder.js';
import { matchRoute, pathnameOf } from './router.js';
import { createPools, startDiscovery } from './upstream.js';
import { resolveTraceId } from './correlation/trace-id.js';
import { createFrameRecorder } from './l7/frame-logger.js';
import { createSlowlorisWatchdog } from './l7/slowloris.js';

const config = loadConfig();
const bus = createFrameBus({ url: config.redisUrl, historyLimit: config.historyLimit });

const slowloris = createSlowlorisWatchdog({
  thresholds: {
    enabled: config.slowlorisEnabled,
    ttfbMs: config.slowlorisTtfbMs,
    headersMs: config.slowlorisHeadersMs,
    bodyMs: config.slowlorisBodyMs,
    idleMs: config.slowlorisIdleMs,
  },
  onTimeout: (event) => {
    console.warn(
      `slowloris phase=${event.phase} reason=${event.reason} client=${event.client} ` +
      `elapsed=${event.elapsedMs}ms bytes=${event.bytesReceived} traceId=${event.traceId ?? '-'}`,
    );
    bus.publishSlowloris(event);
  },
});

const pools = await createPools(config);
const discovery = startDiscovery(config, pools);

// L4 capture (B1). Disabled when CAPTURE_IFACE is empty.
let parsedSampleCount = 0;

const pcapPath = (process.env.PCAP_EXPORT_PATH ?? 'capture.pcap').trim();
const pcapRecorder = pcapPath === '' ? null : new PcapRecorder({ path: pcapPath });

// L4 handshake analyser (B3). Fed from the capture path, publishes one result
// per completed SYN → SYN-ACK → ACK plus an aggregate on every sweep. The
// dashboard bus adapter lands with the Redis transport; until then the console
// publisher makes the analyser observable in the proxy log.
const handshake = new HandshakeAnalyser({
  publisher: createConsoleHandshakePublisher(),
});

const stateMachine = new TcpStateMachine({
  publish: (event) => bus.publishTcpState(event),
});
const stateSweep = setInterval(() => stateMachine.sweep(), 1_000);
stateSweep.unref();

const rtt = new RttAnalyser({
  publish: (event) => bus.publishRtt(event),
});
const rttSweep = setInterval(() => rtt.sweep(), 1_000);
rttSweep.unref();

const retransmit = new RetransmitAnalyser({
  publish: (event) => bus.publishRetransmit(event),
});
const retransmitSweep = setInterval(() => retransmit.sweep(), 1_000);
retransmitSweep.unref();

const capture = config.captureIface
  ? startCapture({
    iface: config.captureIface,
    proxyPort: config.port,
    onPacket: (packet) => {
      // B9: every captured packet is recorded before analysis, so an export
      // contains exactly what the analysers saw. The recorder owns the link
      // type and snapshot behaviour; no inline pcap-format logic here.
      pcapRecorder?.observe(packet);
      const parsed = parsePacket({
        bytes: packet.bytes,
        timestamp: packet.timestamp,
        capturedLength: packet.capturedLength,
        originalLength: packet.originalLength,
        linkType: packet.linkType,
      });

      if (parsed === null) return;

      handshake.observe(parsed);
      stateMachine.observe(parsed);
      rtt.observe(parsed);
      retransmit.observe(parsed);

      // Publish L4 metadata so the dashboard's TCP table is populated from the
      // capture path. Fire-and-forget: publishTcp never awaits Redis.
      bus.publishTcp(toTcpMetadataEvent(parsed));

      if (parsedSampleCount < 5) {
        parsedSampleCount += 1;
        console.log(
          `parsed #${parsedSampleCount} ${parsed.fiveTuple.srcIp}:${parsed.fiveTuple.srcPort} -> ` +
          `${parsed.fiveTuple.dstIp}:${parsed.fiveTuple.dstPort} ` +
          `flags=${parsed.tcp.flags.raw.toString(16)} seq=${parsed.tcp.seq} ack=${parsed.tcp.ack} ` +
          `win=${parsed.tcp.window} scale=${parsed.tcp.options.windowScale ?? '-'} ` +
          `mss=${parsed.tcp.options.mss ?? '-'} ts=${parsed.tcp.options.timestamps?.tsVal ?? '-'}`,
        );
      }
    },
  })
  : null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    pid: process.pid,
    upstreams: [...pools.values()].map((pool) => ({
      group: pool.group,
      instances: pool.stats(),
    })),
  });
}

interface RequestOptions {
  expectContinue?: boolean;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestOptions = {},
): void {
  const pathname = pathnameOf(req.url);

  // B9: a local endpoint, intercepted before route matching so it is never
  // forwarded to the traffic-shaping stub under /api/*.
  if (pathname === '/api/export.pcap') {
    handleExportRequest(req, res, pcapRecorder);
    return;
  }

  if (pathname === '/health' || pathname === '/health/') {
    handleHealth(res);
    return;
  }

  if (pathname === null) {
    sendJson(res, 400, { error: 'bad_request', target: req.url });
    return;
  }

  const route = matchRoute(pathname, config.routes);
  if (route === null) {
    sendJson(res, 404, { error: 'not_found', path: pathname });
    return;
  }

  const pool = pools.get(route.group);
  if (pool === undefined) {
    sendJson(res, 500, { error: 'no_upstream_group', group: route.group });
    return;
  }

  if (pool.empty) {
    sendJson(res, 503, { error: 'no_upstreams', group: route.group });
    return;
  }

  const instance = pool.next();

  console.log(
    `upstream=${instance.id} group=${route.group} ${req.method} ${req.url}`,
  );

  const traceId = resolveTraceId(req);
  slowloris.associateTrace(req, traceId, pathname);
  stateMachine.associateTrace(
    req.socket.remoteAddress ?? '',
    req.socket.remotePort ?? 0,
    traceId,
    pathname,
  );
  const recorder = createFrameRecorder(req, {
    bus,
    traceId,
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    group: route.group,
    upstream: instance.id,
  });

  forward(req, res, instance, {
    traceId,
    onUpstreamResponse: recorder.onUpstreamResponse,
    // Relay the upstream's interim 100 so the client sends its body. Guarded
    // by headersSent: if the upstream answered with a final status instead,
    // writeContinue after writeHead would throw.
    onUpstreamContinue: options.expectContinue
      ? () => {
          if (!res.headersSent) res.writeContinue();
        }
      : undefined,
    onSettled: ({ status }) => {
      recorder.finish(status);
      console.log(`upstream=${instance.id} status=${status} ${req.method} ${req.url}`);
    },
  });
}

const server = createServer((req, res) => {
  slowloris.onRequest(req, res);
  handleRequest(req, res);
});

server.on('connection', (socket) => slowloris.observeConnection(socket));

// A request with Expect: 100-continue arrives here instead of 'request'. The
// proxy forwards the expectation upstream and relays the interim 100 back.
server.on('checkContinue', (req, res) => {
  slowloris.onRequest(req, res);
  handleRequest(req, res, { expectContinue: true });
});

// Discovery runs on a timer; stop it explicitly so a SIGTERM leaves nothing behind.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    discovery.stop();
    capture?.stop();
    handshake.close();
    slowloris.close();
    clearInterval(stateSweep);
    clearInterval(rttSweep);
    clearInterval(retransmitSweep);
    void bus.close();
    void (pcapRecorder?.close() ?? Promise.resolve()).finally(() => server.close(() => process.exit(0)));
  });
}

// The watchdog fires first and reports a reason, but Node's timeouts are a
// backstop rather than being switched off: with SLOWLORIS_ENABLED=false there
// would otherwise be no protection for a client that never sends a byte.
const backstopMs = timeoutBackstopMs(config);
server.headersTimeout = backstopMs;
server.requestTimeout = backstopMs;
server.keepAliveTimeout = backstopMs;

server.listen(config.port, config.host, () => {
  const groups = [...pools.values()]
    .map((pool) => `${pool.group}=[${pool.instances.map((i) => i.id).join(', ')}]`)
    .join(' ');
  console.log(
    `proxy listening on ${config.host}:${config.port} ` +
    `routes=[${config.routes.map((r) => `${r.prefix}->${r.group}`).join(', ')}] ` +
    `upstreams: ${groups}`,
  );
});
