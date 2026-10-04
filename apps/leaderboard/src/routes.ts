// Read-side HTTP: top-N and own-rank. The sorted set is authoritative for ordering; player rows carry
// the username, so a top-N read fans out one Redis call + one Postgres `IN (…)` join.
import { inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { getPlayer, players, type Database } from '@chess/db';
import { LEADERBOARD_KEY } from './keys.js';

export interface LeaderboardDeps {
  db: Database;
  redis: Redis;
}

const MAX_LIMIT = 200;

export function registerRoutes(app: FastifyInstance, deps: LeaderboardDeps): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/leaderboard',
    async (req, reply) => {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit ?? 50)));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
        reply.code(400);
        return { error: 'invalid_pagination' };
      }
      // ZREVRANGE with scores — top-N descending by rating.
      const raw = await deps.redis.zrange(
        LEADERBOARD_KEY,
        offset,
        offset + limit - 1,
        'REV',
        'WITHSCORES',
      );
      const rows: Array<{ playerId: string; rating: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        const playerId = raw[i];
        const rating = Number(raw[i + 1]);
        if (playerId) rows.push({ playerId, rating });
      }
      if (rows.length === 0) return { entries: [], offset, limit };

      const ids = rows.map((r) => r.playerId);
      const names = new Map<string, string>();
      for (const p of await deps.db
        .select({ id: players.playerId, username: players.username })
        .from(players)
        .where(inArray(players.playerId, ids))) {
        names.set(p.id, p.username);
      }

      return {
        offset,
        limit,
        entries: rows.map((r, i) => ({
          rank: offset + i + 1,
          playerId: r.playerId,
          username: names.get(r.playerId) ?? '(unknown)',
          rating: r.rating,
        })),
      };
    },
  );

  app.get<{ Params: { playerId: string } }>('/players/:playerId/rank', async (req, reply) => {
    const player = await getPlayer(deps.db, req.params.playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player_not_found' };
    }
    const rank = await deps.redis.zrevrank(LEADERBOARD_KEY, player.playerId);
    const score = await deps.redis.zscore(LEADERBOARD_KEY, player.playerId);
    return {
      playerId: player.playerId,
      username: player.username,
      // Postgres is the source of truth for the rating itself; Redis contributes the ordering.
      rating: player.rating,
      // null when the player hasn't been applied yet (no games played, or sweeper hasn't caught up).
      rank: rank === null ? null : rank + 1,
      indexedRating: score === null ? null : Number(score),
    };
  });
}
