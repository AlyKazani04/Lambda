// Unit tests for the A2 frame recorder.
//
// These drive a fake request/response pair with an injected clock, so timings
// are exact and no capture, Redis, or real network is involved.

import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import type { FrameBus } from '../bus/redis.js';
import type { FrameEvent } from 'shared-types';

import { createFrameRecorder } from './frame-logger.js';

class RecordingBus implements FrameBus {
  readonly frames: FrameEvent[] = [];
  publishFrame(frame: FrameEvent): void {
    this.frames.push(frame);
  }
  publishTcp(): void {}
  async close(): Promise<void> {}
}

function fakeStream(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage;
}

interface Harness {
  bus: RecordingBus;
  req: IncomingMessage;
  upstream: IncomingMessage;
  clock: { value: number };
}

function harness(): Harness {
  const bus = new RecordingBus();
  const req = fakeStream();
  const upstream = fakeStream();
  const clock = { value: 0 };
  return { bus, req, upstream, clock };
}

function options(bus: RecordingBus, now: () => number) {
  return {
    bus,
    traceId: 'trace-1',
    method: 'GET',
    path: '/slow',
    group: 'api',
    upstream: 'stub-1',
    now,
  };
}

test('publishes exactly one merged frame record per request', () => {
  const h = harness();
  const recorder = createFrameRecorder(h.req, options(h.bus, () => h.clock.value));

  h.clock.value = 10; // request fully received
  h.req.emit('end');
  recorder.onUpstreamResponse(h.upstream);
  h.clock.value = 260; // upstream body finished (250 ms upstream wait)
  h.upstream.emit('end');
  h.clock.value = 265; // response flushed to the client
  recorder.finish(200);

  assert.equal(h.bus.frames.length, 1);
  const frame = h.bus.frames[0]!;
  assert.equal(frame.traceId, 'trace-1');
  assert.equal(frame.hop, 'client→proxy');
  assert.equal(frame.status, 200);
  assert.equal(frame.path, '/slow');
  assert.equal(frame.durationMs, 265); // request leg + upstream wait + flush
  assert.equal(frame.internalMs, 15); // 10 ms request reception + 5 ms flush
});

test('internal time excludes a slow upstream response', () => {
  const h = harness();
  const recorder = createFrameRecorder(h.req, options(h.bus, () => h.clock.value));

  h.req.emit('end'); // at t=0
  recorder.onUpstreamResponse(h.upstream);
  h.clock.value = 250;
  h.upstream.emit('end');
  h.clock.value = 251;
  recorder.finish(200);

  const frame = h.bus.frames[0]!;
  assert.equal(frame.durationMs, 251);
  assert.equal(frame.internalMs, 1); // only the 1 ms flush, not the 250 ms upstream wait
  assert.equal(frame.durationMs - frame.internalMs, 250);
});

test('counts streamed bytes and ignores repeated finish calls', () => {
  const h = harness();
  const recorder = createFrameRecorder(h.req, options(h.bus, () => h.clock.value));

  h.req.emit('data', Buffer.from('hello'));
  h.req.emit('end');
  recorder.onUpstreamResponse(h.upstream);
  h.upstream.emit('data', Buffer.from('world!!'));
  h.upstream.emit('end');
  recorder.finish(201);
  recorder.finish(201);

  assert.equal(h.bus.frames.length, 1);
  assert.equal(h.bus.frames[0]!.requestBytes, 5);
  assert.equal(h.bus.frames[0]!.responseBytes, 7);
  assert.equal(h.bus.frames[0]!.status, 201);
});

test('an upstream error before any response logs a real status and no double-counted internal time', () => {
  const h = harness();
  const recorder = createFrameRecorder(h.req, options(h.bus, () => h.clock.value));

  h.clock.value = 5;
  h.req.emit('end');
  h.clock.value = 50; // connection failure after 45 ms of upstream wait
  recorder.finish(502);

  const frame = h.bus.frames[0]!;
  assert.equal(frame.status, 502);
  assert.equal(frame.durationMs, 50);
  assert.equal(frame.internalMs, 5); // request reception only
});
