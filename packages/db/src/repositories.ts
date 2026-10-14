// Typed data access over Drizzle. The one non-trivial piece is `appendMove`: it writes the move row and
// the clock update inside a transaction guarded on the game's `generation`, so a stale owner cannot
// corrupt a reassigned game.
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { games, moves, players } from './schema.js';
import type { Game, Move, NewGame, NewPlayer, Player } from './schema.js';

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected a returned row but got none');
  return row;
}

// --- players -----------------------------------------------------------------------------------------

export async function insertPlayer(db: Database, player: NewPlayer): Promise<Player> {
  return one(await db.insert(players).values(player).returning());
}

export async function getPlayer(db: Database, playerId: string): Promise<Player | undefined> {
  const rows = await db.select().from(players).where(eq(players.playerId, playerId)).limit(1);
  return rows[0];
}

export async function getPlayerByUsername(
  db: Database,
  username: string,
): Promise<Player | undefined> {
  const rows = await db.select().from(players).where(eq(players.username, username)).limit(1);
  return rows[0];
}

export interface PlayerRecord {
  wins: number;
  losses: number;
  draws: number;
}

/** Count the player's finished results, split by W/L/D. Draws are symmetric; wins/losses depend on
 *  which colour the player was and the result. */
export async function playerRecord(db: Database, playerId: string): Promise<PlayerRecord> {
  const rows = await db.execute<{ wins: string; losses: string; draws: string }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE (result = '1-0' AND white_id = ${playerId}) OR (result = '0-1' AND black_id = ${playerId}))::text AS wins,
      COUNT(*) FILTER (WHERE (result = '0-1' AND white_id = ${playerId}) OR (result = '1-0' AND black_id = ${playerId}))::text AS losses,
      COUNT(*) FILTER (WHERE result = '1/2-1/2' AND (white_id = ${playerId} OR black_id = ${playerId}))::text AS draws
    FROM games
    WHERE (white_id = ${playerId} OR black_id = ${playerId}) AND status = 'finished'
  `);
  const r = rows.rows[0];
  return {
    wins: r ? Number(r.wins) : 0,
    losses: r ? Number(r.losses) : 0,
    draws: r ? Number(r.draws) : 0,
  };
}

export interface RatingPoint {
  at: Date;
  rating: number;
}

/** Rating at the start of each finished game the player played, oldest first. The caller appends
 *  the player's current rating as a final point to draw a line to "now". Capped so the response
 *  stays bounded; a chess career on this stack is unlikely to exceed 500 games anyway. */
export async function playerRatingHistory(
  db: Database,
  playerId: string,
  limit = 200,
): Promise<RatingPoint[]> {
  const rows = await db.execute<{ at: string; rating: number }>(sql`
    SELECT
      created_at AS at,
      CASE WHEN white_id = ${playerId} THEN white_rating_start ELSE black_rating_start END AS rating
    FROM games
    WHERE (white_id = ${playerId} OR black_id = ${playerId}) AND status = 'finished'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({ at: new Date(r.at), rating: Number(r.rating) }));
}

// --- games -------------------------------------------------------------------------------------------

export async function createGame(db: Database, game: NewGame): Promise<Game> {
  return one(await db.insert(games).values(game).returning());
}

export async function getGame(db: Database, gameId: string): Promise<Game | undefined> {
  const rows = await db.select().from(games).where(eq(games.gameId, gameId)).limit(1);
  return rows[0];
}

export async function getMoves(db: Database, gameId: string): Promise<Move[]> {
  return db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply));
}

export interface GameWithOpponent {
  gameId: string;
  timeControl: string;
  status: 'active' | 'finished';
  result: '1-0' | '0-1' | '1/2-1/2' | null;
  endReason: string | null;
  createdAt: Date;
  myColor: 'w' | 'b';
  myRatingStart: number;
  opponent: { playerId: string; username: string; ratingStart: number };
}

/** Paginated history for one player. Cursor is the previous page's last `createdAt`; pass undefined
 *  for the first page. Ordered newest-first so the cursor is a `<` on createdAt. */
export async function listGamesForPlayer(
  db: Database,
  playerId: string,
  opts: { limit?: number; cursor?: Date } = {},
): Promise<GameWithOpponent[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const opponentPlayers = players;
  const base = db
    .select({
      gameId: games.gameId,
      timeControl: games.timeControl,
      status: games.status,
      result: games.result,
      endReason: games.endReason,
      createdAt: games.createdAt,
      whiteId: games.whiteId,
      blackId: games.blackId,
      whiteRatingStart: games.whiteRatingStart,
      blackRatingStart: games.blackRatingStart,
      opponentId: opponentPlayers.playerId,
      opponentUsername: opponentPlayers.username,
    })
    .from(games)
    .innerJoin(
      opponentPlayers,
      // The opponent is whichever side is NOT the viewer.
      or(
        and(eq(games.whiteId, playerId), eq(opponentPlayers.playerId, games.blackId)),
        and(eq(games.blackId, playerId), eq(opponentPlayers.playerId, games.whiteId)),
      ),
    )
    .where(
      and(
        or(eq(games.whiteId, playerId), eq(games.blackId, playerId)),
        ...(opts.cursor ? [lt(games.createdAt, opts.cursor)] : []),
      ),
    )
    .orderBy(desc(games.createdAt))
    .limit(limit);
  const rows = await base;
  return rows.map((r) => {
    const myColor: 'w' | 'b' = r.whiteId === playerId ? 'w' : 'b';
    return {
      gameId: r.gameId,
      timeControl: r.timeControl,
      status: r.status,
      result: r.result,
      endReason: r.endReason,
      createdAt: r.createdAt,
      myColor,
      myRatingStart: myColor === 'w' ? r.whiteRatingStart : r.blackRatingStart,
      opponent: {
        playerId: r.opponentId,
        username: r.opponentUsername,
        ratingStart: myColor === 'w' ? r.blackRatingStart : r.whiteRatingStart,
      },
    };
  });
}

export interface Ownership {
  generation: number;
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
}

/** Bump `generation` to claim ownership (what a replacement game-server does after replaying moves).
 *  Returns undefined if the game is missing or already finished. */
export async function takeOwnership(db: Database, gameId: string): Promise<Ownership | undefined> {
  const rows = await db
    .update(games)
    .set({ generation: sql`${games.generation} + 1`, updatedAt: sql`now()` })
    .where(and(eq(games.gameId, gameId), eq(games.status, 'active')))
    .returning({
      generation: games.generation,
      whiteMs: games.whiteMs,
      blackMs: games.blackMs,
      turn: games.turn,
    });
  return rows[0];
}

export interface AppendMoveParams {
  gameId: string;
  expectedGeneration: number;
  move: { moveNumber: number; ply: number; san: string; uci: string; clockMs: number };
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
}

/** The hot-path write: append one move + update both clocks + turn, in one transaction, guarded on
 *  `generation`. Returns false (writing nothing) if the caller's generation is stale. */
export async function appendMove(db: Database, params: AppendMoveParams): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(games)
      .set({
        whiteMs: params.whiteMs,
        blackMs: params.blackMs,
        turn: params.turn,
        updatedAt: sql`now()`,
      })
      .where(and(eq(games.gameId, params.gameId), eq(games.generation, params.expectedGeneration)))
      .returning({ gameId: games.gameId });
    if (updated.length === 0) return false;
    await tx.insert(moves).values({ gameId: params.gameId, ...params.move });
    return true;
  });
}

export interface FinishGameParams {
  gameId: string;
  expectedGeneration: number;
  result: '1-0' | '0-1' | '1/2-1/2';
  endReason: string;
}

export async function finishGame(db: Database, params: FinishGameParams): Promise<boolean> {
  const updated = await db
    .update(games)
    .set({
      status: 'finished',
      result: params.result,
      endReason: params.endReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(games.gameId, params.gameId), eq(games.generation, params.expectedGeneration)))
    .returning({ gameId: games.gameId });
  return updated.length > 0;
}
