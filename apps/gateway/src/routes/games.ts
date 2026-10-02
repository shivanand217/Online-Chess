// GET /games/:id — simple read-through from Postgres, exposing just the public fields a client needs to
// bootstrap the UI (both players, current clocks, status, result if finished). Move log reads land here
// later; for now the game-server WebSocket owns the live stream.
import type { FastifyInstance } from 'fastify';
import { getGame, type Database } from '@chess/db';

export interface GamesDeps {
  db: Database;
}

export function registerGamesRoute(app: FastifyInstance, deps: GamesDeps): void {
  app.get<{ Params: { gameId: string } }>('/games/:gameId', async (req, reply) => {
    const game = await getGame(deps.db, req.params.gameId);
    if (!game) {
      reply.code(404);
      return { error: 'game_not_found' };
    }
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
    };
  });
}
