import { Redis } from 'ioredis';

let reader: Redis | null = null;

/**
 * Shared connection for ordinary commands (LRANGE, INFO). A subscriber
 * connection cannot run ordinary commands, so the bridge keeps a separate one.
 */
export function getReader(): Redis {
  if (reader === null) {
    reader = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
    reader.on('error', (err) => {
      console.error(`redis reader: ${err.message}`);
    });
  }
  return reader;
}
