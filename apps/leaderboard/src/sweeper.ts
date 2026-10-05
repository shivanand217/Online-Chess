// Periodic poll over finished-but-unrated games. The alternative (pub/sub from the game-server) is a
// nice optimisation, but the poller is the correctness backstop — if a notification is ever lost we
// still catch up on the next tick.
import { and, asc, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import { games, type Database } from '@chess/db';
import { applyRatingForGame } from './apply.js';
import { pendingGames } from './metrics.js';

export interface SweeperDeps {
  db: Database;
  redis: Redis;
  /** How many games to drain per tick — bounds the DB load during a backlog. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 100;

export async function tick(deps: SweeperDeps): Promise<number> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const pending = await deps.db
    .select({ gameId: games.gameId })
    .from(games)
    .where(and(eq(games.status, 'finished'), eq(games.ratingApplied, false)))
    .orderBy(asc(games.updatedAt))
    .limit(batchSize);
  pendingGames.set(pending.length);

  let applied = 0;
  for (const row of pending) {
    const result = await applyRatingForGame(deps.db, deps.redis, row.gameId);
    if (result) applied += 1;
  }
  return applied;
}

export interface Sweeper {
  stop: () => Promise<void>;
}

export function startSweeper(
  deps: SweeperDeps,
  intervalMs = 500,
  onError: (err: unknown) => void = (err) => {
    console.error('[leaderboard] tick failed', err);
  },
): Sweeper {
  let stopped = false;
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
  const inflight = run();
  return {
    stop: async () => {
      stopped = true;
      await inflight;
    },
  };
}
