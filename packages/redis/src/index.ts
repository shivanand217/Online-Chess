// Central place to construct Redis clients with sane defaults, so matchmaking and leaderboard share one
// configuration, plus a small helper for registering Lua scripts (ioredis `defineCommand`) that services
// invoke like native commands. Hand-written.
import Redis, { type RedisOptions } from 'ioredis';

/** Create an ioredis client. `lazyConnect` keeps construction non-blocking at startup. */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, ...options });
}

export interface ScriptDefinition {
  /** Command name attached to the client — becomes `redis.<name>(...)`. */
  name: string;
  /** Number of KEYS the script expects; the rest of the args are ARGV. */
  numberOfKeys: number;
  /** Script source. */
  lua: string;
}

/**
 * Register a Lua script on a client (idempotent per-script) via ioredis `defineCommand`.
 * ioredis handles EVALSHA caching and NOSCRIPT retries for us; callers invoke it as `(redis as any).<name>`.
 * Centralised so every script's source lives next to its registration and no service re-wires it.
 */
export function defineScript(redis: Redis, script: ScriptDefinition): void {
  // defineCommand is idempotent for a given name/source; re-registering across tests is safe.
  redis.defineCommand(script.name, { numberOfKeys: script.numberOfKeys, lua: script.lua });
}
