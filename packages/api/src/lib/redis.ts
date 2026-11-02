import Redis from 'ioredis';
import { logger } from '../utils/logger';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(redisUrl, {
  family: 4, // Force IPv4 — prevents ECONNRESET on Windows with Docker
  retryStrategy: (times) => {
    if (times > 20) {
      logger.error('Redis: max reconnect attempts reached');
      return null;
    }
    const delay = Math.min(times * 100, 5000);
    logger.info(`Redis: reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error', { error: err.message });
});

redisClient.on('connect', () => {
  logger.info('Redis connected');
});

const DEL_IF_EQUALS_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// ioredis-compatible wrapper matching node-redis API used in the codebase
export const redis = {
  get: (key: string) => redisClient.get(key),
  set: (key: string, value: string) => redisClient.set(key, value),
  setEx: (key: string, seconds: number, value: string) =>
    redisClient.setex(key, seconds, value),
  del: (key: string) => redisClient.del(key),
  incr: (key: string) => redisClient.incr(key),
  /** SET key value NX PX ttlMs — true when the key was set. */
  setNxPx: async (key: string, value: string, ttlMs: number): Promise<boolean> =>
    (await redisClient.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
  /** GETDEL — read and delete atomically. */
  getDel: (key: string): Promise<string | null> => redisClient.getdel(key),
  /** Deletes the key only while it still holds `value` (atomic compare-and-delete). */
  delIfEquals: async (key: string, value: string): Promise<boolean> =>
    (await redisClient.eval(DEL_IF_EQUALS_LUA, 1, key, value)) === 1,
  ping: () => redisClient.ping(),
  quit: () => redisClient.quit(),
  isReady: redisClient.status === 'ready',
};

export type RedisLike = Pick<
  typeof redis,
  'get' | 'setEx' | 'del' | 'incr' | 'setNxPx' | 'getDel' | 'delIfEquals'
>;

export default redis;
