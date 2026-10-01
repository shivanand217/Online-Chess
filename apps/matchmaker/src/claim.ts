// The race-free pairing primitive. A Lua script runs on the Redis side so the "find a candidate" scan
// and the two ZREMs that book both waiters execute as one atomic unit — no two matchmaker workers can
// book the same opponent, which is the invariant Phase 2's concurrency test proves.
//
// Why Lua, not WATCH/MULTI: with hundreds of workers all contending on a hot mid-band waiter, optimistic
// retry loops collapse into livelock. Lua removes the race entirely: Redis serialises script execution,
// so a successful ZREM is proof of claim.
//
// The script also skips the caller's own entry (so a worker running a self-match pass can't pair a
// player with themselves) and returns the paired requestId so the caller can read its metadata and
// create the Game. Hand-written.
import type Redis from 'ioredis';
import { defineScript } from '@chess/redis';
import { poolKey } from './keys.js';

/**
 * KEYS[1] = pool sorted set
 * ARGV[1] = caller's requestId (excluded from the candidate pool so no self-match)
 * ARGV[2] = window minimum score (inclusive)
 * ARGV[3] = window maximum score (inclusive)
 *
 * Returns the paired peer's requestId (string), or nil if no eligible candidate was found.
 * On success BOTH waiters are removed from the pool in the same script invocation — a loser worker
 * calling the script against the same pool will see neither entry and return nil.
 */
const CLAIM_LUA = `
  local pool = KEYS[1]
  local self = ARGV[1]
  local lo = tonumber(ARGV[2])
  local hi = tonumber(ARGV[3])

  local candidates = redis.call('ZRANGEBYSCORE', pool, lo, hi, 'LIMIT', 0, 8)
  for i = 1, #candidates do
    local peer = candidates[i]
    if peer ~= self then
      -- ZREM is the atomic claim: whoever's call returns 1 won the race.
      if redis.call('ZREM', pool, peer) == 1 then
        redis.call('ZREM', pool, self)
        return peer
      end
    end
  end
  return false
`;

const SCRIPT_NAME = 'mmClaim';

/** Register the claim script on this client. Call once per client (e.g. at startup / in tests). */
export function registerClaimScript(redis: Redis): void {
  defineScript(redis, { name: SCRIPT_NAME, numberOfKeys: 1, lua: CLAIM_LUA });
}

export interface ClaimParams {
  timeControl: string;
  /** The caller's own requestId — excluded from the candidate scan so a worker can't self-match. */
  requestId: string;
  /** Caller's rating — the window is centred on this. */
  rating: number;
  /** +/- window width in ELO points. The widener grows this as the caller waits. */
  window: number;
}

/**
 * Attempt one atomic pairing round for `requestId`. Returns the paired peer's requestId, or null if no
 * eligible waiter exists inside the current rating window — in which case the caller stays in the pool
 * and the widener will try again with a wider window on its next tick.
 */
export async function tryClaim(redis: Redis, params: ClaimParams): Promise<string | null> {
  const lo = params.rating - params.window;
  const hi = params.rating + params.window;
  // ioredis types `defineCommand` as `any` on the client — the cast is the typed surface we present.
  const result = (await (
    redis as unknown as {
      mmClaim: (pool: string, self: string, lo: number, hi: number) => Promise<string | null>;
    }
  ).mmClaim(poolKey(params.timeControl), params.requestId, lo, hi)) as string | null;
  // Lua returns `false` → ioredis surfaces as `null`.
  return result ?? null;
}
