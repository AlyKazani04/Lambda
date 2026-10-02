import { createServer } from 'node:http';

// Bare bootstrap so the image has something to run and the week-1 exit
// criterion (proxy listening, traffic visible on the NIC) is demonstrable.
// Path routing, upstream selection and frame logging arrive in #15 (A1).
const port = Number(process.env.PROXY_PORT ?? 8080);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: req.url }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`proxy listening on 0.0.0.0:${port} iface=${process.env.CAPTURE_IFACE ?? 'unset'}`);
});