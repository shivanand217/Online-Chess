// GET /leaderboard?limit&offset  → top-N by rating
// GET /players/:playerId/rank    → the player's current rank
// Both are read-through proxies to the leaderboard service.
import type { FastifyInstance } from 'fastify';
import type { LeaderboardClient } from '../leaderboard-client.js';

export interface LeaderboardRouteDeps {
  leaderboard: LeaderboardClient;
}

export function registerLeaderboardRoutes(app: FastifyInstance, deps: LeaderboardRouteDeps): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/leaderboard',
    async (req, reply) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
      const offset = Math.max(0, Number(req.query.offset ?? 0));
      if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
        reply.code(400);
        return { error: 'invalid_pagination' };
      }
      try {
        return await deps.leaderboard.topN(limit, offset);
      } catch (err) {
        req.log.error({ err }, 'leaderboard proxy failed');
        reply.code(502);
        return { error: 'leaderboard_unavailable' };
      }
    },
  );

  app.get<{ Params: { playerId: string } }>('/players/:playerId/rank', async (req, reply) => {
    try {
      const rank = await deps.leaderboard.playerRank(req.params.playerId);
      if (!rank) {
        reply.code(404);
        return { error: 'player_not_found' };
      }
      return rank;
    } catch (err) {
      req.log.error({ err }, 'player rank proxy failed');
      reply.code(502);
      return { error: 'leaderboard_unavailable' };
    }
  });
}
