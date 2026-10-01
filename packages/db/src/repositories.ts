// Typed data access over Drizzle. The one non-trivial piece is `appendMove`: it writes the move row and
// the clock update inside a transaction guarded on the game's `generation`, so a stale owner cannot
// corrupt a reassigned game.
import { and, asc, eq, sql } from 'drizzle-orm';
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
