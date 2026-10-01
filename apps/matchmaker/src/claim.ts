// Atomic pairing. The Lua script scans the pool inside the caller's rating window and ZREMs both members
// in one invocation; a successful ZREM is proof of claim, so no two workers can book the same opponent.
// Done this way rather than WATCH/MULTI because optimistic retries livelock under heavy contention.
import type Redis from 'ioredis';
import { defineScript } from '@chess/redis';
import { poolKey } from './keys.js';

const CLAIM_LUA = `
  local pool = KEYS[1]
  local self = ARGV[1]
  local lo = tonumber(ARGV[2])
  local hi = tonumber(ARGV[3])

  local candidates = redis.call('ZRANGEBYSCORE', pool, lo, hi, 'LIMIT', 0, 8)
  for i = 1, #candidates do
    local peer = candidates[i]
    if peer ~= self then
      if redis.call('ZREM', pool, peer) == 1 then
        redis.call('ZREM', pool, self)
        return peer
      end
    end
  end
  return false
`;

const SCRIPT_NAME = 'mmClaim';

export function registerClaimScript(redis: Redis): void {
  defineScript(redis, { name: SCRIPT_NAME, numberOfKeys: 1, lua: CLAIM_LUA });
}

export interface ClaimParams {
  timeControl: string;
  requestId: string;
  rating: number;
  window: number;
}

/** One pairing attempt. Returns the paired peer's requestId, or null if nothing matched this window. */
export async function tryClaim(redis: Redis, params: ClaimParams): Promise<string | null> {
  const client = redis as unknown as {
    mmClaim: (pool: string, self: string, lo: number, hi: number) => Promise<string | null>;
  };
  const result = await client.mmClaim(
    poolKey(params.timeControl),
    params.requestId,
    params.rating - params.window,
    params.rating + params.window,
  );
  return result ?? null;
}
