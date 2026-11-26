// A4 watchdog tests. No real sockets or wall-clock waits: a fake clock owns
// the timers, and fake streams expose just the events the watchdog observes.

import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { SlowlorisEvent } from 'shared-types';

import { createSlowlorisWatchdog, type SlowlorisThresholds } from './slowloris.js';

class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();

  set = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
}

class FakeSocket extends EventEmitter {
  remoteAddress = '127.0.0.1';
  remotePort = 4321;
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

interface Harness {
  clock: FakeClock;
  socket: FakeSocket;
  req: IncomingMessage;
  res: ServerResponse;
  events: SlowlorisEvent[];
  watchdog: ReturnType<typeof createSlowlorisWatchdog>;
}

const THRESHOLDS: SlowlorisThresholds = {
  enabled: true,
  ttfbMs: 100,
  headersMs: 200,
  bodyMs: 300,
  idleMs: 400,
};

function harness(thresholds: SlowlorisThresholds = THRESHOLDS): Harness {
  const clock = new FakeClock();
  const socket = new FakeSocket();
  const req = new EventEmitter() as IncomingMessage;
  Object.defineProperty(req, 'socket', { value: socket });
  const res = new EventEmitter() as ServerResponse;
  const events: SlowlorisEvent[] = [];
  const watchdog = createSlowlorisWatchdog({
    thresholds,
    onTimeout: (event) => events.push(event),
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  watchdog.observeConnection(socket as unknown as Socket);
  return { clock, socket, req, res, events, watchdog };
}

function request(h: Harness): void {
  h.watchdog.onRequest(h.req, h.res);
}

function bytes(h: Harness, count: number): void {
  h.socket.emit('data', Buffer.alloc(count));
}

test('ttfb timeout fires with a reason and destroys the socket', () => {
  const h = harness();
  h.clock.advance(99);
  assert.equal(h.events.length, 0);
  h.clock.advance(1);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.phase, 'ttfb');
  assert.equal(h.events[0]?.reason, 'no_bytes_before_first_byte');
  assert.equal(h.events[0]?.elapsedMs, 100);
  assert.equal(h.events[0]?.client, '127.0.0.1:4321');
  assert.equal(h.socket.destroyed, true);
});

test('a trickling client resets the headers timer and is not killed', () => {
  const h = harness();
  bytes(h, 40);
  h.clock.advance(150);
  bytes(h, 5);
  h.clock.advance(150);
  assert.equal(h.events.length, 0);
  h.clock.advance(50);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.phase, 'headers');
  assert.equal(h.events[0]?.bytesReceived, 5, 'byte count is per phase, not per connection');
  assert.equal(h.events[0]?.elapsedMs, 200, 'timer was re-armed at the last byte');
});

test('slow body is detected even when headers arrived quickly', () => {
  const h = harness();
  bytes(h, 100);
  request(h);
  h.clock.advance(200);
  bytes(h, 10);
  h.clock.advance(250);
  assert.equal(h.events.length, 0);
  h.clock.advance(50);
  assert.equal(h.events[0]?.phase, 'body');
  assert.equal(h.events[0]?.reason, 'body_idle');
});

test('a connection idle after a response is detected', () => {
  const h = harness();
  request(h);
  h.res.emit('finish');
  h.clock.advance(399);
  assert.equal(h.events.length, 0);
  h.clock.advance(1);
  assert.equal(h.events[0]?.phase, 'idle');
  assert.equal(h.events[0]?.reason, 'idle_after_response');
});

test('keep-alive resets per request, not per connection lifetime', () => {
  const h = harness();
  request(h);
  h.res.emit('finish');
  h.clock.advance(350); // into the idle window, but not over it

  request(h);
  h.clock.advance(250); // body window, not exhausted
  h.res.emit('finish');
  assert.equal(h.events.length, 0);

  h.clock.advance(400);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.phase, 'idle');
});

test('associated trace and path travel with the event', () => {
  const h = harness();
  request(h);
  h.watchdog.associateTrace(h.req, 'trace-7', '/api/slow');
  h.clock.advance(300);
  assert.equal(h.events[0]?.traceId, 'trace-7');
  assert.equal(h.events[0]?.path, '/api/slow');
});

test('close clears every timer without emitting', () => {
  const h = harness();
  request(h);
  h.watchdog.close();
  h.clock.advance(10_000);
  assert.equal(h.events.length, 0);
});

test('disabled watchdog installs no timers and never destroys a socket', () => {
  const h = harness({ ...THRESHOLDS, enabled: false });
  h.clock.advance(10_000);
  assert.equal(h.events.length, 0);
  assert.equal(h.socket.destroyed, false);
});
