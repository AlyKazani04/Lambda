import { createServer } from 'node:http';

// Bootstrap only. The engineered network behaviours (status rotation, chunked
// streaming, mid-response socket destroy, artificial latency) are issue #8 / F3.
const port = Number(process.env.STUB_PORT ?? 3001);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ stub: true, path: req.url }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`stub listening on 0.0.0.0:${port}`);
});