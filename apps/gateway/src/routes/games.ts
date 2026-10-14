// Game endpoints:
//   GET /games/:gameId           — one game's summary + live wsUrl (if still active)
//   GET /games/:gameId/moves     — the full ordered move log (used by the replay viewer)
//   GET /players/:playerId/games — paginated history for a player, newest first
import type { FastifyInstance } from 'fastify';
import { getGame, getMoves, listGamesForPlayer, type Database } from '@chess/db';
import type { RouterClient } from '../router-client.js';

export interface GamesDeps {
  db: Database;
  router: RouterClient;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function registerGamesRoute(app: FastifyInstance, deps: GamesDeps): void {
  app.get<{ Params: { gameId: string } }>('/games/:gameId', async (req, reply) => {
    const game = await getGame(deps.db, req.params.gameId);
    if (!game) {
      reply.code(404);
      return { error: 'game_not_found' };
    }
    // Only active games have a server to connect to.
    const route = game.status === 'active' ? await deps.router.routeFor(game.gameId) : undefined;
    return {
      gameId: game.gameId,
      whiteId: game.whiteId,
      blackId: game.blackId,
      timeControl: game.timeControl,
      whiteMs: game.whiteMs,
      blackMs: game.blackMs,
      turn: game.turn,
      status: game.status,
      result: game.result,
      endReason: game.endReason,
      ...(route ? { wsUrl: route.wsUrl } : {}),
    };
  });

  app.get<{ Params: { gameId: string } }>('/games/:gameId/moves', async (req, reply) => {
    const game = await getGame(deps.db, req.params.gameId);
    if (!game) {
      reply.code(404);
      return { error: 'game_not_found' };
    }
    const log = await getMoves(deps.db, req.params.gameId);
    return { moves: log.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, clockMs: m.clockMs })) };
  });

  app.get<{
    Params: { playerId: string };
    Querystring: { limit?: string; cursor?: string };
  }>('/players/:playerId/games', async (req, reply) => {
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.parseInt(req.query.limit ?? '', 10) || DEFAULT_LIMIT),
    );
    let cursor: Date | undefined;
    if (req.query.cursor) {
      const d = new Date(req.query.cursor);
      if (Number.isNaN(d.getTime())) {
        reply.code(400);
        return { error: 'invalid_cursor' };
      }
      cursor = d;
    }
    const rows = await listGamesForPlayer(deps.db, req.params.playerId, {
      limit,
      ...(cursor ? { cursor } : {}),
    });
    // Expose the next cursor as the oldest returned row's createdAt — undefined if we got fewer than `limit`.
    const nextCursor =
      rows.length === limit ? rows[rows.length - 1]?.createdAt.toISOString() : undefined;
    return {
      games: rows.map((r) => ({
        gameId: r.gameId,
        timeControl: r.timeControl,
        status: r.status,
        result: r.result,
        endReason: r.endReason,
        createdAt: r.createdAt.toISOString(),
        myColor: r.myColor,
        myRatingStart: r.myRatingStart,
        opponent: r.opponent,
      })),
      ...(nextCursor ? { nextCursor } : {}),
    };
  });
}
