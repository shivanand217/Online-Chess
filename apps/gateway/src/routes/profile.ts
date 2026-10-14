// GET /players/:username/profile — public player summary: rating, rank, W/L/D, join date, and
// rating-over-time points for the frontend sparkline.
import type { FastifyInstance } from 'fastify';
import {
  getPlayerByUsername,
  listGamesForPlayer,
  playerRatingHistory,
  playerRecord,
  type Database,
} from '@chess/db';
import type { LeaderboardClient } from '../leaderboard-client.js';

export interface ProfileDeps {
  db: Database;
  leaderboard: LeaderboardClient;
}

const RECENT_LIMIT = 10;

export function registerProfileRoute(app: FastifyInstance, deps: ProfileDeps): void {
  app.get<{ Params: { username: string } }>('/players/:username/profile', async (req, reply) => {
    const player = await getPlayerByUsername(deps.db, req.params.username);
    if (!player) {
      reply.code(404);
      return { error: 'player_not_found' };
    }

    const [record, history, recent, rank] = await Promise.all([
      playerRecord(deps.db, player.playerId),
      playerRatingHistory(deps.db, player.playerId),
      listGamesForPlayer(deps.db, player.playerId, { limit: RECENT_LIMIT }),
      // Soft-fail the rank lookup — profile should still render if the leaderboard service is down.
      deps.leaderboard.playerRank(player.playerId).catch(() => undefined),
    ]);

    return {
      playerId: player.playerId,
      username: player.username,
      rating: player.rating,
      gamesPlayed: player.gamesPlayed,
      createdAt: player.createdAt.toISOString(),
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      rank: rank?.rank ?? null,
      // History + a trailing "now" point so the chart's rightmost tick is the current rating.
      ratingHistory: [
        ...history.map((p) => ({ at: p.at.toISOString(), rating: p.rating })),
        { at: new Date().toISOString(), rating: player.rating },
      ],
      recentGames: recent.map((g) => ({
        gameId: g.gameId,
        timeControl: g.timeControl,
        status: g.status,
        result: g.result,
        endReason: g.endReason,
        createdAt: g.createdAt.toISOString(),
        myColor: g.myColor,
        myRatingStart: g.myRatingStart,
        opponent: g.opponent,
      })),
    };
  });
}
