import { Redis } from 'ioredis';

import {
  FRAME_CHANNEL,
  FRAME_HISTORY_KEY,
  TCP_CHANNEL,
  TCP_HISTORY_KEY,
  type FrameEvent,
  type TcpMetadataEvent,
} from 'shared-types';

export interface BusConfig {
  url: string;
  historyLimit: number;
}

export interface FrameBus {
  publishFrame(frame: FrameEvent): void;
  publishTcp(event: TcpMetadataEvent): void;
  close(): Promise<void>;
}

export function createFrameBus(config: BusConfig): FrameBus {
  const redis = new Redis(config.url, {
    // Reject commands issued while Redis is down instead of queueing them, so
    // a dead Redis can never accumulate work or enter the request path.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });

  redis.on('error', (err) => {
    console.error(`redis bus: ${err.message}`);
  });

  function publish(channel: string, historyKey: string, payload: unknown): void {
    const json = JSON.stringify(payload);
    void redis.publish(channel, json).catch(() => undefined);
    // MULTI/EXEC keeps the push and the trim atomic: a dropped or reordered
    // LTRIM would let the list grow past the cap under load.
    void redis
      .multi()
      .lpush(historyKey, json)
      .ltrim(historyKey, 0, config.historyLimit - 1)
      .exec()
      .catch(() => undefined);
  }

  return {
    publishFrame: (frame) => publish(FRAME_CHANNEL, FRAME_HISTORY_KEY, frame),
    publishTcp: (event) => publish(TCP_CHANNEL, TCP_HISTORY_KEY, event),
    close: async () => {
      await redis.quit().catch(() => undefined);
    },
  };
}
