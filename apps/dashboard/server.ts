import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import next from 'next';
import { WebSocketServer } from 'ws';

import { createBridge } from './lib/ws.js';

const port = Number(process.env.DASHBOARD_PORT ?? 3000);
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const historyLimit = Number(process.env.HISTORY_LIMIT ?? 10_000);

const dev = process.env.NODE_ENV !== 'production';
// Pin the app directory to this file: the container runs the server from the
// repo root, where Next would otherwise look for .next in the wrong place.
const dir = path.dirname(fileURLToPath(import.meta.url));
const app = next({ dev, dir });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer((req, res) => {
  void handle(req, res);
});

const bridge = createBridge({ redisUrl, historyLimit });
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  bridge.addClient(ws);
});

server.listen(port, () => {
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.address : '0.0.0.0';
  const shown = bound === '::' || bound === '0.0.0.0' ? '0.0.0.0' : bound;
  console.log(`dashboard listening on http://${shown}:${port}`);
});
