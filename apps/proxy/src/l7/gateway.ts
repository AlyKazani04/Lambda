// A8: TLS front door.
//
// A single net server peeks the ClientHello, reads SNI, then either hands the
// socket to a TLS server (full termination) or pipes it untouched to a TLS
// upstream (routing on SNI alone). Both decrypted and plaintext requests end
// up in the same http.Server request listener, so there is one router and one
// frame logger rather than two implementations that can drift.

import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { Duplex } from 'node:stream';
import type { SecureContext } from 'node:tls';

import type { ProxyConfig, TlsHostRoute } from '../config.js';
import { timeoutBackstopMs } from '../config.js';
import type { FrameBus } from '../bus/redis.js';
import { parseSniFromClientHello } from './tls.js';

// A ClientHello is a few hundred bytes at most. This cap stops a client that
// never completes a record from growing the buffer without bound.
const MAX_CLIENT_HELLO_BYTES = 16 * 1024;

export interface DecryptedRequestContext {
  sni: string;
  group: string;
  logSecrets: boolean;
}

export interface TlsGatewayOptions {
  config: ProxyConfig;
  bus: FrameBus;
  onDecryptedRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    context: DecryptedRequestContext,
  ) => void;
  /** Installed on each TLS socket so the A4 watchdog sees TLS connections too. */
  onSecureConnection?: (socket: TLSSocket) => void;
  onError?: (message: string) => void;
}

export interface TlsGateway {
  /** Starts listening and resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

function loadContext(config: ProxyConfig, route: TlsHostRoute): SecureContext {
  const certFile = route.certFile ?? config.tlsCertFile;
  const keyFile = route.keyFile ?? config.tlsKeyFile;
  return createSecureContext({
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  });
}

function sniOf(socket: TLSSocket): string {
  return typeof socket.servername === 'string' ? socket.servername.toLowerCase() : '';
}

export function createTlsGateway(options: TlsGatewayOptions): TlsGateway {
  const { config, bus } = options;
  const warn = (message: string): void => {
    (options.onError ?? ((text) => console.warn(text)))(`tls: ${message}`);
  };

  const decryptByHost = new Map<string, TlsHostRoute>();
  const passthroughByHost = new Map<string, TlsHostRoute>();
  for (const route of config.tlsHosts) {
    if (route.mode === 'decrypt') decryptByHost.set(route.host, route);
    else passthroughByHost.set(route.host, route);
  }

  // Certificates are read once at startup: a missing key is a configuration
  // error, not something to discover on the first client handshake.
  const contexts = new Map<string, SecureContext>();
  for (const [host, route] of decryptByHost) {
    contexts.set(host, loadContext(config, route));
  }
  if (contexts.size === 0) {
    throw new Error('TLS termination needs at least one decrypt host with a certificate');
  }

  const httpServer = createHttpServer((req, res) => {
    const sni = sniOf(req.socket as TLSSocket);
    const route = decryptByHost.get(sni);
    if (route === undefined) {
      res.destroy();
      return;
    }
    options.onDecryptedRequest(req, res, {
      sni,
      group: route.group ?? '',
      logSecrets: config.tlsLogSecrets,
    });
  });
  const backstopMs = timeoutBackstopMs(config);
  httpServer.headersTimeout = backstopMs;
  httpServer.requestTimeout = backstopMs;
  httpServer.keepAliveTimeout = backstopMs;

  const active = new Set<Socket>();

  // The SNI hostname has already been read from the ClientHello, so the
  // certificate is chosen here rather than through tls.Server's SNICallback.
  // Emitting the decrypted TLSSocket into the plain http.Server drives the
  // ordinary HTTP parser over it, which is what lets TLS reuse handleRequest.
  function acceptDecrypted(socket: Socket, sni: string, firstBytes: Buffer): void {
    const context = contexts.get(sni);
    if (context === undefined) {
      warn(`no certificate for ${sni}`);
      socket.destroy();
      return;
    }

    // A TLSSocket wrapping a real net.Socket reads from the C++ handle and
    // would miss the ClientHello bytes already buffered in the JS stream by
    // the SNI peek. Bridging through a Duplex makes TLSSocket use its JS-stream
    // path, where the peeked bytes can be pushed back verbatim.
    const bridge = new Duplex({
      read: () => socket.resume(),
      write: (chunk: Buffer, _encoding, callback) => {
        socket.write(chunk);
        callback();
      },
    });
    socket.on('data', (chunk: Buffer) => {
      if (!bridge.push(chunk)) socket.pause();
    });
    socket.on('close', () => bridge.destroy());
    socket.on('error', () => bridge.destroy());
    bridge.on('close', () => socket.destroy());
    bridge.push(firstBytes);

    const tlsSocket = new TLSSocket(bridge, {
      isServer: true,
      secureContext: context,
      requestCert: false,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    active.add(tlsSocket);
    tlsSocket.once('secure', () => {
      options.onSecureConnection?.(tlsSocket);
      httpServer.emit('connection', tlsSocket);
    });
    tlsSocket.on('error', (error: Error) => warn(`handshake failed: ${error.message}`));
    socket.resume();
  }

  function pipePassthrough(socket: Socket, route: TlsHostRoute, firstBytes: Buffer): void {
    const target = route.target;
    if (target === undefined) {
      warn(`${route.host} has no passthrough target`);
      socket.destroy();
      return;
    }

    const upstream = connect({ host: target.host, port: target.port });
    active.add(upstream);
    let requestBytes = 0;
    let routePublished = false;
    const publishRoute = (): void => {
      if (routePublished) return;
      routePublished = true;
      bus.publishSniRoute({
        host: route.host,
        mode: 'passthrough',
        upstream: `${target.host}:${target.port}`,
        requestBytes,
        timestamp: Date.now(),
      });
    };

    upstream.on('connect', () => {
      // The peeked bytes are the start of the ClientHello; the upstream must
      // receive them verbatim or the TLS handshake will fail.
      upstream.write(firstBytes);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
    });
    socket.on('data', (chunk: Buffer) => { requestBytes += chunk.length; });
    upstream.on('error', (error) => {
      warn(`passthrough to ${route.host} failed: ${error.message}`);
      socket.destroy();
    });
    upstream.on('end', publishRoute);
    upstream.on('close', () => {
      active.delete(upstream);
      publishRoute();
    });
  }

  const server = createNetServer((socket) => {
    active.add(socket);
    socket.on('close', () => active.delete(socket));

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const parsed = parseSniFromClientHello(buffered);
      if (parsed.status === 'incomplete') {
        if (buffered.length > MAX_CLIENT_HELLO_BYTES) {
          socket.off('data', onData);
          socket.destroy();
        }
        return;
      }

      socket.off('data', onData);
      socket.pause();
      if (parsed.status === 'invalid' || parsed.host === null) {
        warn('connection without a usable SNI hostname');
        socket.destroy();
        return;
      }

      const passthrough = passthroughByHost.get(parsed.host);
      if (passthrough !== undefined) {
        pipePassthrough(socket, passthrough, buffered);
        return;
      }

      if (!decryptByHost.has(parsed.host)) {
        warn(`no route for ${parsed.host}`);
        socket.destroy();
        return;
      }

      acceptDecrypted(socket, parsed.host, buffered);
    };

    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
  });

  return {
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.tlsPort, config.host, () => {
        server.off('error', reject);
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : config.tlsPort);
      });
    }),

    close: () => new Promise<void>((resolve) => {
      for (const socket of active) socket.destroy();
      active.clear();
      server.close(() => resolve());
    }),
  };
}
