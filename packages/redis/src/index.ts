// Shared ioredis client factory + a thin wrapper over `defineCommand` so services register Lua scripts
// in one consistent way (the matchmaker's atomic claim is the first user).
import Redis, { type RedisOptions } from 'ioredis';

export function createRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null, ...options });
}

export interface ScriptDefinition {
  name: string;
  numberOfKeys: number;
  lua: string;
}

export function defineScript(redis: Redis, script: ScriptDefinition): void {
  redis.defineCommand(script.name, { numberOfKeys: script.numberOfKeys, lua: script.lua });
}
