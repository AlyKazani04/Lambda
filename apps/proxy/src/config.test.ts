// A4 threshold parsing. Ports and millisecond timeouts are different domains:
// readInt's 65535 ceiling must not be applied to a 60 s idle timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SLOWLORIS_BODY_MS,
  DEFAULT_SLOWLORIS_HEADERS_MS,
  DEFAULT_SLOWLORIS_IDLE_MS,
  DEFAULT_SLOWLORIS_TTFB_MS,
  DEFAULT_TLS_PORT,
  loadConfig,
  parseTlsHosts,
  timeoutBackstopMs,
} from './config.js';

test('slowloris defaults are generous enough for the netem path', () => {
  const config = loadConfig({});
  assert.equal(config.slowlorisEnabled, true);
  assert.equal(config.slowlorisTtfbMs, DEFAULT_SLOWLORIS_TTFB_MS);
  assert.equal(config.slowlorisHeadersMs, DEFAULT_SLOWLORIS_HEADERS_MS);
  assert.equal(config.slowlorisBodyMs, DEFAULT_SLOWLORIS_BODY_MS);
  assert.equal(config.slowlorisIdleMs, DEFAULT_SLOWLORIS_IDLE_MS);
});

test('thresholds are overridable without a code change', () => {
  const config = loadConfig({
    SLOWLORIS_ENABLED: 'false',
    SLOWLORIS_TTFB_MS: '3000',
    SLOWLORIS_HEADERS_MS: '4500',
    SLOWLORIS_BODY_MS: '6000',
    SLOWLORIS_IDLE_MS: '90000',
  });
  assert.equal(config.slowlorisEnabled, false);
  assert.equal(config.slowlorisTtfbMs, 3000);
  assert.equal(config.slowlorisHeadersMs, 4500);
  assert.equal(config.slowlorisBodyMs, 6000);
  assert.equal(config.slowlorisIdleMs, 90_000);
});

test('invalid threshold and enable values fail at startup', () => {
  assert.throws(() => loadConfig({ SLOWLORIS_TTFB_MS: '0' }), /SLOWLORIS_TTFB_MS/);
  assert.throws(() => loadConfig({ SLOWLORIS_HEADERS_MS: '7000000' }), /SLOWLORIS_HEADERS_MS/);
  assert.throws(() => loadConfig({ SLOWLORIS_IDLE_MS: 'abc' }), /SLOWLORIS_IDLE_MS/);
  assert.throws(() => loadConfig({ SLOWLORIS_ENABLED: 'maybe' }), /SLOWLORIS_ENABLED/);
});

test('TLS is off by default and secrets stay out of the frame log', () => {
  const config = loadConfig({});
  assert.equal(config.tlsEnabled, false);
  assert.equal(config.tlsPort, DEFAULT_TLS_PORT);
  assert.deepEqual(config.tlsHosts, []);
  assert.equal(config.tlsLogSecrets, false);
});

test('SNI routes normalise hostnames and validate each mode', () => {
  const hosts = parseTlsHosts(JSON.stringify([
    { host: ' Secure.Example ', mode: 'decrypt', group: 'api' },
    {
      host: 'tunnel.example',
      mode: 'passthrough',
      target: '127.0.0.1:8444',
      certFile: 'ignored.pem',
    },
  ]));

  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts[0], { host: 'secure.example', mode: 'decrypt', group: 'api' });
  assert.deepEqual(hosts[1], {
    host: 'tunnel.example',
    mode: 'passthrough',
    target: { host: '127.0.0.1', port: 8444 },
  });
});

test('malformed SNI routes fail at startup', () => {
  assert.throws(() => parseTlsHosts('{'), /TLS_SNI_ROUTES must be JSON/);
  assert.throws(() => parseTlsHosts('[]'), /non-empty JSON array/);
  assert.throws(() => parseTlsHosts('[{"host":"a","mode":" sniff "}]'), /mode/);
  assert.throws(() => parseTlsHosts('[{"host":"a","mode":"decrypt"}]'), /needs a group/);
  assert.throws(() => parseTlsHosts('[{"host":"a","mode":"passthrough"}]'), /needs a host:port target/);
  assert.throws(
    () => parseTlsHosts('[{"host":"a","mode":"passthrough","target":"a:1,b:2"}]'),
    /exactly one/,
  );
  assert.throws(
    () => parseTlsHosts('[{"host":"a","mode":"decrypt","group":"g"},{"host":"A","mode":"decrypt","group":"g"}]'),
    /duplicate host/,
  );
});

test('enabling TLS without key material fails fast', () => {
  assert.throws(
    () => loadConfig({ TLS_ENABLED: 'true' }),
    /at least one TLS_SNI_ROUTES host/,
  );
  assert.throws(
    () => loadConfig({
      TLS_ENABLED: 'true',
      TLS_SNI_ROUTES: '[{"host":"secure.example","mode":"decrypt","group":"api"}]',
    }),
    /certificate and key are required/,
  );

  // A per-host pair satisfies validation; a passthrough-only host needs none.
  const config = loadConfig({
    TLS_ENABLED: 'true',
    TLS_SNI_ROUTES: JSON.stringify([
      {
        host: 'secure.example',
        mode: 'decrypt',
        group: 'api',
        certFile: 'certs/secure.pem',
        keyFile: 'certs/secure-key.pem',
      },
      { host: 'tunnel.example', mode: 'passthrough', target: '127.0.0.1:8444' },
    ]),
    TLS_LOG_SECRETS: 'true',
    TLS_PORT: '9443',
  });
  assert.equal(config.tlsEnabled, true);
  assert.equal(config.tlsPort, 9443);
  assert.equal(config.tlsLogSecrets, true);
  assert.equal(config.tlsHosts[0]?.certFile, 'certs/secure.pem');
});

test('timeout backstop stays above the longest watchdog threshold', () => {
  assert.equal(timeoutBackstopMs(loadConfig({})), DEFAULT_SLOWLORIS_IDLE_MS + 1000);

  // The idle threshold is not always the largest; the backstop must follow
  // whichever one is, including with the watchdog disabled.
  const config = loadConfig({
    SLOWLORIS_ENABLED: 'false',
    SLOWLORIS_TTFB_MS: '3000',
    SLOWLORIS_HEADERS_MS: '4500',
    SLOWLORIS_IDLE_MS: '2000',
    SLOWLORIS_BODY_MS: '6000',
  });
  assert.equal(timeoutBackstopMs(config), 7000);
});
