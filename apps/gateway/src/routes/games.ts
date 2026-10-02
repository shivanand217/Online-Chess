// GET /games/:id — simple read-through from Postgres, exposing just the public fields a client needs to
// bootstrap the UI (both players, current clocks, status, result if finished). Move log reads land here
// later; for now the game-server WebSocket owns the live stream.
import type { FastifyInstance } from 'fastify';
import { getGame, type Database } from '@chess/db';
import type { RouterClient } from '../router-client.js';

export interface GamesDeps {
  db: Database;
  router: RouterClient;
}

export function registerGamesRoute(app: FastifyInstance, deps: GamesDeps): void {
  app.get<{ Params: { gameId: string } }>('/games/:gameId', async (req, reply) => {
    const game = await getGame(deps.db, req.params.gameId);
    if (!game) {
      reply.code(404);
      return { error: 'game_not_found' };
    }
    // The route is only meaningful for active games — finished games have no server to connect to.
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
}
