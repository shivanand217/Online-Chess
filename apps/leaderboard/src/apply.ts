// Idempotent ELO apply. The game row carries `rating_applied` as a boolean guard; the SQL transaction's
// first statement flips it from false → true and returns the row only if it was still false. A replay
// (same gameId arriving twice) finds the row already applied, returns zero rows, and we exit cleanly.
// Postgres is the source of truth; the Redis ZADD that follows is best-effort — the reconcile pass is
// the backstop against drift.
import { and, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { games, players, type Database } from '@chess/db';
import { ratingChange } from '@chess/domain';
import { LEADERBOARD_KEY } from './keys.js';
import { eloApplyDurationSeconds } from './metrics.js';

export interface AppliedResult {
  gameId: string;
  whiteId: string;
  blackId: string;
  whiteRating: number;
  blackRating: number;
  whiteDelta: number;
  blackDelta: number;
}

export async function applyRatingForGame(
  db: Database,
  redis: Redis,
  gameId: string,
): Promise<AppliedResult | null> {
  const start = process.hrtime.bigint();
  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(games)
      .set({ ratingApplied: true, updatedAt: sql`now()` })
      .where(
        and(eq(games.gameId, gameId), eq(games.status, 'finished'), eq(games.ratingApplied, false)),
      )
      .returning({
        whiteId: games.whiteId,
        blackId: games.blackId,
        whiteStart: games.whiteRatingStart,
        blackStart: games.blackRatingStart,
        gameResult: games.result,
      });
    const g = claimed[0];
    // Either the game wasn't finished, didn't exist, or someone else claimed it first.
    if (!g || !g.gameResult) return null;

    const { whiteDelta, blackDelta } = ratingChange(g.whiteStart, g.blackStart, g.gameResult);

    const [newWhite] = await tx
      .update(players)
      .set({
        rating: sql`${players.rating} + ${whiteDelta}`,
        gamesPlayed: sql`${players.gamesPlayed} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(players.playerId, g.whiteId))
      .returning({ rating: players.rating });
    const [newBlack] = await tx
      .update(players)
      .set({
        rating: sql`${players.rating} + ${blackDelta}`,
        gamesPlayed: sql`${players.gamesPlayed} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(players.playerId, g.blackId))
      .returning({ rating: players.rating });
    if (!newWhite || !newBlack) {
      throw new Error(`unknown player on finished game ${gameId}`);
    }

    return {
      gameId,
      whiteId: g.whiteId,
      blackId: g.blackId,
      whiteRating: newWhite.rating,
      blackRating: newBlack.rating,
      whiteDelta,
      blackDelta,
    } satisfies AppliedResult;
  });

  if (!result) {
    eloApplyDurationSeconds.observe(
      { result: 'noop' },
      Number(process.hrtime.bigint() - start) / 1e9,
    );
    return null;
  }

  // Fan the new ratings into Redis so top-N / rank reads reflect them immediately. One ZADD covers both
  // members; failure here is non-fatal — the reconcile pass rebuilds from Postgres truth.
  await redis.zadd(
    LEADERBOARD_KEY,
    result.whiteRating,
    result.whiteId,
    result.blackRating,
    result.blackId,
  );
  eloApplyDurationSeconds.observe(
    { result: 'applied' },
    Number(process.hrtime.bigint() - start) / 1e9,
  );
  return result;
}
