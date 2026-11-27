import { Redis } from 'ioredis';

import {
  FRAME_CHANNEL,
  FRAME_HISTORY_KEY,
  TCP_CHANNEL,
  TCP_HISTORY_KEY,
  TCP_STATE_CHANNEL,
  TCP_STATE_HISTORY_KEY,
  RTT_CHANNEL,
  RTT_HISTORY_KEY,
  RETRANSMIT_CHANNEL,
  RETRANSMIT_HISTORY_KEY,
  SLOWLORIS_CHANNEL,
  SLOWLORIS_HISTORY_KEY,
  type FrameEvent,
  type RetransmitEvent,
  type SlowlorisEvent,
  type RttEstimateEvent,
  type TcpMetadataEvent,
  type TcpStateEvent,
} from 'shared-types';

export interface BusConfig {
  url: string;
  historyLimit: number;
}

export interface FrameBus {
  publishFrame(frame: FrameEvent): void;
  publishTcp(event: TcpMetadataEvent): void;
  publishTcpState(event: TcpStateEvent): void;
  publishRtt(event: RttEstimateEvent): void;
  publishRetransmit(event: RetransmitEvent): void;
  publishSlowloris(event: SlowlorisEvent): void;
  ready(): Promise<void>;
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
  const pending = new Set<Promise<unknown>>();

  redis.on('error', (err) => {
    console.error(`redis bus: ${err.message}`);
  });

  function ready(): Promise<void> {
    if (redis.status === 'ready') return Promise.resolve();
    return new Promise((resolve) => redis.once('ready', () => resolve()));
  }

  function publish(channel: string, historyKey: string, payload: unknown): void {
    const json = JSON.stringify(payload);
    const write = Promise.allSettled([
      redis.publish(channel, json),
      // MULTI/EXEC keeps the push and the trim atomic: a dropped or reordered
      // LTRIM would let the list grow past the cap under load.
      redis.multi().lpush(historyKey, json).ltrim(historyKey, 0, config.historyLimit - 1).exec(),
    ]);
    pending.add(write);
    void write.then(() => pending.delete(write));
  }

  return {
    publishFrame: (frame) => publish(FRAME_CHANNEL, FRAME_HISTORY_KEY, frame),
    publishTcp: (event) => publish(TCP_CHANNEL, TCP_HISTORY_KEY, event),
    publishTcpState: (event) => publish(TCP_STATE_CHANNEL, TCP_STATE_HISTORY_KEY, event),
    publishRtt: (event) => publish(RTT_CHANNEL, RTT_HISTORY_KEY, event),
    publishRetransmit: (event) => publish(RETRANSMIT_CHANNEL, RETRANSMIT_HISTORY_KEY, event),
    publishSlowloris: (event) => publish(SLOWLORIS_CHANNEL, SLOWLORIS_HISTORY_KEY, event),
    ready,
    close: async () => {
      await Promise.allSettled([...pending]);
      await redis.quit().catch(() => undefined);
    },
  };
}
