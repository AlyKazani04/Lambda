// A8: TLS termination and SNI routing.
//
// The routing decision has to happen before decryption, so the proxy reads the
// hostname straight out of the TLS ClientHello. TLS records are length-prefixed
// and the first record of a handshake contains the ClientHello, which lets us
// tell "not enough bytes yet" apart from "not a ClientHello at all".

export type SniParseResult =
  | { status: 'complete'; host: string | null }
  | { status: 'incomplete' }
  | { status: 'invalid' };

const SERVER_NAME_EXTENSION = 0x0000;
const HOST_NAME = 0x00;

function u16(bytes: Buffer, offset: number): number {
  return bytes.readUInt16BE(offset);
}

/**
 * Parse the SNI hostname from the first bytes of a TLS connection.
 *
 * `incomplete` means the ClientHello is not fully buffered yet; the caller
 * should wait for more data. `invalid` means these bytes cannot be a normal
 * ClientHello and the connection should be closed. A `complete` result with a
 * null host is a valid ClientHello that simply carries no SNI extension.
 */
export function parseSniFromClientHello(bytes: Buffer): SniParseResult {
  if (bytes.length < 5) return { status: 'incomplete' };
  if (bytes[0]! !== 0x16 || bytes[1]! !== 0x03) return { status: 'invalid' };

  const recordLength = u16(bytes, 3);
  const recordEnd = 5 + recordLength;
  if (bytes.length < recordEnd) return { status: 'incomplete' };
  if (recordEnd > bytes.length || recordLength < 4) return { status: 'invalid' };

  if (bytes[5] !== 0x01) return { status: 'invalid' };
  const handshakeLength = bytes.readUIntBE(6, 3);
  const handshakeEnd = 9 + handshakeLength;
  if (bytes.length < handshakeEnd) return { status: 'incomplete' };
  if (handshakeEnd > recordEnd) return { status: 'invalid' };

  // ClientHello body: version(2), random(32), session id, cipher suites,
  // compression methods, then optional extensions.
  let cursor = 9;
  const need = (count: number): boolean => cursor + count <= handshakeEnd;
  if (!need(34)) return { status: 'invalid' };
  cursor += 34;

  if (!need(1)) return { status: 'invalid' };
  const sessionIdLength = bytes[cursor++]!;
  if (!need(sessionIdLength)) return { status: 'invalid' };
  cursor += sessionIdLength;

  if (!need(2)) return { status: 'invalid' };
  const cipherSuitesLength = u16(bytes, cursor);
  cursor += 2;
  if (!need(cipherSuitesLength)) return { status: 'invalid' };
  cursor += cipherSuitesLength;

  if (!need(1)) return { status: 'invalid' };
  const compressionMethodsLength = bytes[cursor++]!;
  if (!need(compressionMethodsLength)) return { status: 'invalid' };
  cursor += compressionMethodsLength;

  if (cursor === handshakeEnd) return { status: 'complete', host: null };
  if (!need(2)) return { status: 'invalid' };
  const extensionsLength = u16(bytes, cursor);
  cursor += 2;
  const extensionsEnd = cursor + extensionsLength;
  if (extensionsEnd > handshakeEnd) return { status: 'invalid' };

  while (cursor < extensionsEnd) {
    if (cursor + 4 > extensionsEnd) return { status: 'invalid' };
    const type = u16(bytes, cursor);
    const length = u16(bytes, cursor + 2);
    cursor += 4;
    if (cursor + length > extensionsEnd) return { status: 'invalid' };

    if (type === SERVER_NAME_EXTENSION) {
      if (length < 5) return { status: 'invalid' };
      const listLength = u16(bytes, cursor);
      if (listLength + 2 !== length) return { status: 'invalid' };
      let entry = cursor + 2;
      const listEnd = cursor + 2 + listLength;
      while (entry + 3 <= listEnd) {
        const nameType = bytes[entry]!;
        const nameLength = u16(bytes, entry + 1);
        entry += 3;
        if (entry + nameLength > listEnd) return { status: 'invalid' };
        if (nameType === HOST_NAME && nameLength > 0) {
          const host = bytes.subarray(entry, entry + nameLength).toString('ascii');
          const normalised = host.toLowerCase().replace(/\.$/, '');
          if (!/^[a-z0-9.-]+$/.test(normalised)) return { status: 'invalid' };
          return { status: 'complete', host: normalised };
        }
        entry += nameLength;
      }
      return { status: 'complete', host: null };
    }

    cursor += length;
  }

  return { status: 'complete', host: null };
}
