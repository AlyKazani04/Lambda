import { Redis } from 'ioredis';
import { WebSocket } from 'ws';

import {
  FRAME_CHANNEL,
  FRAME_HISTORY_KEY,
  TCP_CHANNEL,
  TCP_HISTORY_KEY,
} from 'shared-types';

export interface BridgeConfig {
  redisUrl: string;
  historyLimit: number;
}

export interface RedisBridge {
  addClient(ws: WebSocket): void;
  close(): Promise<void>;
}

interface StreamMessage {
  channel: string;
  payload: unknown;
}

export function createBridge(config: BridgeConfig): RedisBridge {
  // Honour the configured history cap; the old hardcoded 200 made this field
  // dead and ignored an operator's HISTORY_LIMIT setting. Floor at 1 so
  // `lrange 0 -1` can never accidentally return the entire list.
  const backfillLimit = Math.max(1, Math.floor(config.historyLimit));
  // A subscriber connection enters a mode where ordinary commands are refused,
  // so history reads use a second connection.
  const subscriber = new Redis(config.redisUrl, {
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  const reader = new Redis(config.redisUrl, {
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  const clients = new Set<WebSocket>();

  subscriber.on('error', (err) => console.error(`redis subscriber: ${err.message}`));
  reader.on('error', (err) => console.error(`redis reader: ${err.message}`));

  subscriber.on('message', (channel: string, message: string) => {
    broadcast({ channel, payload: parse(message) });
  });

  void subscriber.subscribe(FRAME_CHANNEL, TCP_CHANNEL).catch(() => undefined);

  function parse(message: string): unknown {
    try {
      return JSON.parse(message) as unknown;
    } catch {
      return null;
    }
  }

  function broadcast(message: StreamMessage): void {
    const json = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  async function backfill(ws: WebSocket): Promise<void> {
    try {
      // LPUSH puts the newest entry at index 0, so the first page is recent history.
      const frames = await reader.lrange(FRAME_HISTORY_KEY, 0, backfillLimit - 1);
      for (const item of frames.reverse()) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ channel: FRAME_CHANNEL, payload: parse(item) }));
      }
      const tcp = await reader.lrange(TCP_HISTORY_KEY, 0, backfillLimit - 1);
      for (const item of tcp.reverse()) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ channel: TCP_CHANNEL, payload: parse(item) }));
      }
    } catch (err) {
      console.error(`backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    addClient: (ws) => {
      // Register teardown first: the socket may close while history is being
      // sent, and a half-open socket must never linger in the broadcast set.
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));

      // Backfill before joining the broadcast set. The client prepends every
      // message it receives, so a live frame broadcast during the async
      // backfill would end up buried beneath the history that follows it.
      // Frames published in this short window are intentionally dropped rather
      // than delivered out of order; the next live message re-syncs the view.
      void backfill(ws).then(() => {
        if (ws.readyState === WebSocket.OPEN) clients.add(ws);
      });
    },
    close: async () => {
      await subscriber.quit().catch(() => undefined);
      await reader.quit().catch(() => undefined);
    },
  };
}
