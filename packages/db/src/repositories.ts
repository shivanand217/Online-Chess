// Data-access repositories: thin, typed functions over Drizzle. They hold *no* application logic — services
// compose them. The one non-trivial piece is the generation-guarded move write, the fence from LLD Deep
// Dive 2. Every function takes a `Database` (or transaction), so callers control connection scope. Hand-written.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { games, moves, players } from './schema.js';
import type { Game, Move, NewGame, NewPlayer, Player } from './schema.js';

/** Unwrap a single required returned row, failing loudly if the write returned nothing. */
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

/** The move log in ply order — exactly what {@link ChessEngine.replay} consumes to rebuild the board. */
export async function getMoves(db: Database, gameId: string): Promise<Move[]> {
  return db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply));
}

/** Live state a new owner needs after taking over a game (LLD Deep Dive 2 recovery). */
export interface Ownership {
  generation: number;
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
}

/**
 * Claim ownership of an active game by bumping its generation, returning the new generation + live state.
 * A replacement game-server calls this after replaying the move log; the higher generation fences out the
 * previous (possibly still-alive) owner. Returns undefined if the game is missing or already finished.
 */
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
  /** The generation the caller believes it owns; the write is rejected if the row has moved past it. */
  expectedGeneration: number;
  move: { moveNumber: number; ply: number; san: string; uci: string; clockMs: number };
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
}

/**
 * The core hot-path write: append one move AND update both clocks + turn, in a single transaction, guarded
 * on `generation`. Returns true if applied; false if the caller's generation is stale (a newer owner
 * exists) — in which case nothing is written, so a partitioned-but-alive zombie cannot mutate a reassigned
 * game (LLD Deep Dive 2, "the fence"). The guarded UPDATE takes a row lock, serialising concurrent writers.
 */
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
    if (updated.length === 0) return false; // stale generation → reject, appending nothing
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

/** Mark a game finished (also generation-guarded). Returns false if the caller's generation is stale. */
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
