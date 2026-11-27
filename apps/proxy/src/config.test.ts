// A4 threshold parsing. Ports and millisecond timeouts are different domains:
// readInt's 65535 ceiling must not be applied to a 60 s idle timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SLOWLORIS_BODY_MS,
  DEFAULT_SLOWLORIS_HEADERS_MS,
  DEFAULT_SLOWLORIS_IDLE_MS,
  DEFAULT_SLOWLORIS_TTFB_MS,
  loadConfig,
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
