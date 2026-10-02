// Background sweeper. Each tick walks every known pool, grows the search window per waiter based on how
// long they've been queued, and runs `tryClaim`. On a successful claim it notifies both sides; past the
// configured max wait it publishes an `expired` message and dequeues so the gateway can 408 cleanly.
//
// `tick` is public so tests can drive one pass at a time without racing a real interval.
import type Redis from 'ioredis';
import type { Database } from '@chess/db';
import type { MatchExpired } from '@chess/protocol';
import { tryClaim } from './claim.js';
import { matchChannel, requestKey } from './keys.js';
import { notifyPairing, type ResolvePlayer } from './notify.js';
import { getWaiter } from './pool.js';
import { DEFAULT_WIDEN, isExpired, windowFor, type WidenConfig } from './widen.js';

export interface SweeperDeps {
  redis: Redis;
  db: Database;
  resolvePlayer: ResolvePlayer;
  widen?: WidenConfig;
  now?: () => number;
}

export interface TickStats {
  pools: number;
  claimed: number;
  expired: number;
}

const POOL_SCAN_PATTERN = 'mm:pool:*';

async function listPoolKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', POOL_SCAN_PATTERN, 'COUNT', 100);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

function timeControlFromPoolKey(key: string): string {
  return key.slice('mm:pool:'.length);
}

/** One pass over every pool. Safe to call concurrently with enqueue: `tryClaim` is atomic. */
export async function tick(deps: SweeperDeps): Promise<TickStats> {
  const widen = deps.widen ?? DEFAULT_WIDEN;
  const now = (deps.now ?? Date.now)();
  const stats: TickStats = { pools: 0, claimed: 0, expired: 0 };

  for (const key of await listPoolKeys(deps.redis)) {
    stats.pools += 1;
    const timeControl = timeControlFromPoolKey(key);
    const members = await deps.redis.zrange(key, 0, -1);

    for (const requestId of members) {
      const waiter = await getWaiter(deps.redis, requestId);
      if (!waiter) continue; // raced with a claim or cancel

      const waitedMs = now - waiter.enqueuedAt;

      if (isExpired(waitedMs, widen)) {
        const payload: MatchExpired = { type: 'expired', requestId };
        await deps.redis.publish(matchChannel(requestId), JSON.stringify(payload));
        await deps.redis.pipeline().zrem(key, requestId).del(requestKey(requestId)).exec();
        stats.expired += 1;
        continue;
      }

      const peer = await tryClaim(deps.redis, {
        timeControl,
        requestId,
        rating: waiter.rating,
        window: windowFor(waitedMs, widen),
      });
      if (!peer) continue;

      await notifyPairing(deps.redis, deps.db, {
        callerRequestId: requestId,
        peerRequestId: peer,
        resolvePlayer: deps.resolvePlayer,
      });
      stats.claimed += 1;
    }
  }

  return stats;
}

export interface Sweeper {
  stop: () => Promise<void>;
}

/** Fire `tick` on an interval. Errors are logged and swallowed so one bad tick can't crash the service. */
export function startSweeper(
  deps: SweeperDeps,
  intervalMs = 100,
  onError: (err: unknown) => void = (err) => {
    console.error('[matchmaker] tick failed', err);
  },
): Sweeper {
  let stopped = false;
  let inflight: Promise<unknown> = Promise.resolve();
  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tick(deps);
      } catch (err) {
        onError(err);
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  inflight = run();
  return {
    stop: async () => {
      stopped = true;
      await inflight;
    },
  };
}
