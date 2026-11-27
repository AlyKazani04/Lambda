// A4 slowloris watchdog.
//
// Progress, not elapsed time, is the signal: a client on a slow link is fine
// as long as bytes keep arriving. One timer per socket is re-armed by any byte
// and by phase changes, and is cleared in exactly one place (dispose). Node's
// own headersTimeout/requestTimeout are deliberately not used as detectors —
// they measure total time, not progress, and cannot report a reason.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { SlowlorisEvent, SlowlorisPhase } from 'shared-types';

export interface SlowlorisThresholds {
  enabled: boolean;
  ttfbMs: number;
  headersMs: number;
  bodyMs: number;
  idleMs: number;
}

export interface SlowlorisOptions {
  thresholds: SlowlorisThresholds;
  onTimeout: (event: SlowlorisEvent) => void;
  /** Injectable for deterministic tests; production uses the real timer. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface ConnectionState {
  socket: Socket;
  phase: SlowlorisPhase;
  phaseBytes: number;
  lastProgressAt: number;
  timer: unknown;
  armed: boolean;
  disposed: boolean;
  traceId?: string;
  path?: string;
}

const REASONS: Record<SlowlorisPhase, string> = {
  ttfb: 'no_bytes_before_first_byte',
  headers: 'headers_idle',
  body: 'body_idle',
  idle: 'idle_after_response',
};

export interface SlowlorisWatchdog {
  observeConnection(socket: Socket): void;
  onRequest(req: IncomingMessage, res: ServerResponse): void;
  associateTrace(req: IncomingMessage, traceId: string, path: string): void;
  close(): void;
}

export function createSlowlorisWatchdog(options: SlowlorisOptions): SlowlorisWatchdog {
  const { thresholds } = options;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const connections = new Map<Socket, ConnectionState>();

  function thresholdFor(phase: SlowlorisPhase): number {
    switch (phase) {
      case 'ttfb': return thresholds.ttfbMs;
      case 'headers': return thresholds.headersMs;
      case 'body': return thresholds.bodyMs;
      case 'idle': return thresholds.idleMs;
    }
  }

  function dispose(state: ConnectionState): void {
    if (state.disposed) return;
    state.disposed = true;
    if (state.armed) clearTimer(state.timer);
    state.armed = false;
    connections.delete(state.socket);
  }

  function arm(state: ConnectionState): void {
    if (state.disposed) return;
    if (state.armed) clearTimer(state.timer);
    state.armed = true;
    state.timer = setTimer(() => trip(state), thresholdFor(state.phase));
  }

  function enterPhase(state: ConnectionState, phase: SlowlorisPhase): void {
    if (state.disposed) return;
    state.phase = phase;
    state.phaseBytes = 0;
    state.lastProgressAt = now();
    arm(state);
  }

  function trip(state: ConnectionState): void {
    if (state.disposed) return;
    const event: SlowlorisEvent = {
      phase: state.phase,
      reason: REASONS[state.phase],
      client: `${state.socket.remoteAddress ?? ''}:${state.socket.remotePort ?? 0}`,
      elapsedMs: Math.max(0, now() - state.lastProgressAt),
      bytesReceived: state.phaseBytes,
      timestamp: now(),
      ...(state.traceId === undefined ? {} : { traceId: state.traceId }),
      ...(state.path === undefined ? {} : { path: state.path }),
    };
    dispose(state);
    state.socket.destroy();
    options.onTimeout(event);
  }

  return {
    observeConnection(socket): void {
      if (!thresholds.enabled || connections.has(socket)) return;

      const state: ConnectionState = {
        socket,
        phase: 'ttfb',
        phaseBytes: 0,
        lastProgressAt: now(),
        timer: undefined,
        armed: false,
        disposed: false,
      };
      connections.set(socket, state);

      // The HTTP parser already has a data listener on this socket; adding an
      // observer does not consume chunks away from it. Do not pause/resume
      // here — that would change backpressure for every request.
      socket.on('data', (chunk: Buffer) => {
        if (state.disposed) return;
        state.phaseBytes += chunk.length;
        state.lastProgressAt = now();
        if (state.phase === 'ttfb') enterPhase(state, 'headers');
        else arm(state);
      });
      socket.on('close', () => dispose(state));
      socket.on('error', () => dispose(state));

      enterPhase(state, 'ttfb');
    },

    onRequest(req, res): void {
      const state = connections.get(req.socket);
      if (state === undefined || state.disposed) return;
      enterPhase(state, 'body');
      // One listener per response, owned here so the caller does not have to
      // remember to re-arm the idle timer on every early-return path.
      res.once('finish', () => {
        if (!state.disposed && connections.get(req.socket) === state) {
          enterPhase(state, 'idle');
        }
      });
    },

    associateTrace(req, traceId, path): void {
      const state = connections.get(req.socket);
      if (state === undefined || state.disposed) return;
      state.traceId = traceId;
      state.path = path;
    },

    close(): void {
      // Timers alone are not enough: a keep-alive socket can outlive this
      // watchdog and hold server.close() open on SIGTERM. Dispose first so the
      // socket's 'close' listener is a no-op, then destroy the socket.
      for (const state of [...connections.values()]) {
        dispose(state);
        state.socket.destroy();
      }
    },
  };
}
