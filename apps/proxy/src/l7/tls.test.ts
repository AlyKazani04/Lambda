// Unit tests for the A8 SNI parser. Real ClientHello bytes are assembled here
// so no network or certificate is needed to exercise the wire format.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSniFromClientHello } from './tls.js';

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}

function clientHello(host?: string, extraExtension = false): Buffer {
  const extensions: Buffer[] = [];
  if (extraExtension) {
    extensions.push(Buffer.concat([u16(0x0010), u16(2), Buffer.from([0x00, 0x00])]));
  }
  if (host !== undefined) {
    const name = Buffer.from(host, 'ascii');
    const entry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]);
    const list = Buffer.concat([u16(entry.length), entry]);
    extensions.push(Buffer.concat([u16(0x0000), u16(list.length), list]));
  }

  const parts: Buffer[] = [
    Buffer.alloc(2), // client version
    Buffer.alloc(32), // random
    Buffer.from([0]), // empty session id
    u16(2), Buffer.from([0x13, 0x01]), // one cipher suite
    Buffer.from([1]), Buffer.from([0]), // null compression
  ];
  if (extensions.length > 0) {
    const ext = Buffer.concat(extensions);
    parts.push(u16(ext.length), ext);
  }

  const body = Buffer.concat(parts);
  const handshakeLength = Buffer.alloc(3);
  handshakeLength.writeUIntBE(body.length, 0, 3);
  const handshake = Buffer.concat([Buffer.from([0x01]), handshakeLength, body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

test('extracts the SNI hostname from a ClientHello', () => {
  assert.deepEqual(parseSniFromClientHello(clientHello('secure.example')), {
    status: 'complete',
    host: 'secure.example',
  });
});

test('accepts a ClientHello with no SNI extension', () => {
  assert.deepEqual(parseSniFromClientHello(clientHello()), {
    status: 'complete',
    host: null,
  });
});

test('skips unrelated extensions before the SNI extension', () => {
  assert.deepEqual(parseSniFromClientHello(clientHello('secure.example', true)), {
    status: 'complete',
    host: 'secure.example',
  });
});

test('normalises hostname case and a trailing dot', () => {
  assert.deepEqual(parseSniFromClientHello(clientHello('Secure.Example.')), {
    status: 'complete',
    host: 'secure.example',
  });
});

test('reports incomplete bytes separately from malformed ones', () => {
  const hello = clientHello('secure.example');
  assert.deepEqual(parseSniFromClientHello(hello.subarray(0, 3)), { status: 'incomplete' });
  assert.deepEqual(parseSniFromClientHello(hello.subarray(0, hello.length - 1)), {
    status: 'incomplete',
  });
  assert.deepEqual(
    parseSniFromClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n')),
    { status: 'invalid' },
  );

  const wrongHandshake = Buffer.from(hello);
  wrongHandshake[5] = 0x02;
  assert.deepEqual(parseSniFromClientHello(wrongHandshake), { status: 'invalid' });
});

test('rejects a malformed server_name extension', () => {
  const hello = clientHello('a.example');
  // Corrupt the extension length field inside the handshake.
  hello[hello.length - 4] = 0xff;
  assert.equal(parseSniFromClientHello(hello).status, 'invalid');
});
