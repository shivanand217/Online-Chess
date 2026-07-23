// Central place to construct Redis clients with sane defaults, so matchmaking and leaderboard share one
// configuration. Lua scripts (e.g. the atomic claim) will be registered here in Phase 2. Hand-written.
import Redis, { type RedisOptions } from 'ioredis';

/** Create an ioredis client. `lazyConnect` keeps construction non-blocking at startup. */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, ...options });
}
