// In-memory map of live GameSessions keyed by gameId, with a dedupe lock so two concurrent WS joins for
// the same unknown gameId only run `takeOwnership` + replay once.
import { ChessEngine } from '@chess/chess-engine';
import { getGame, getMoves, takeOwnership, type Database, type Game } from '@chess/db';
import { parseTimeControl } from '@chess/domain';
import { GameSession } from './session.js';

export class SessionManager {
  private readonly sessions = new Map<string, GameSession>();
  private readonly inflight = new Map<string, Promise<GameSession | undefined>>();

  constructor(private readonly db: Database) {}

  get(gameId: string): GameSession | undefined {
    return this.sessions.get(gameId);
  }

  /** Return the session for `gameId`, loading it from the DB (replaying moves) on a miss. Returns
   *  undefined if the game doesn't exist or has already finished. */
  async acquire(gameId: string): Promise<GameSession | undefined> {
    const existing = this.sessions.get(gameId);
    if (existing) return existing;
    const pending = this.inflight.get(gameId);
    if (pending) return pending;

    const load = this.load(gameId).finally(() => this.inflight.delete(gameId));
    this.inflight.set(gameId, load);
    return load;
  }

  private async load(gameId: string): Promise<GameSession | undefined> {
    const game = await getGame(this.db, gameId);
    if (!game || game.status !== 'active') return undefined;

    const ownership = await takeOwnership(this.db, gameId);
    if (!ownership) return undefined;

    const moves = await getMoves(this.db, gameId);
    const engine = ChessEngine.replay(moves.map((m) => m.uci));
    const session = new GameSession({
      gameId,
      whiteId: game.whiteId,
      blackId: game.blackId,
      engine,
      whiteMs: ownership.whiteMs,
      blackMs: ownership.blackMs,
      turn: ownership.turn,
      generation: ownership.generation,
      timeControl: parseTimeControl(game.timeControl),
      ply: moves.length,
    });
    this.sessions.set(gameId, session);
    return session;
  }

  /** Evict a finished game from memory. */
  release(gameId: string): void {
    this.sessions.delete(gameId);
  }

  /** Snapshot of the known Game row for the gateway/client bootstrap paths. */
  async describe(gameId: string): Promise<Game | undefined> {
    return getGame(this.db, gameId);
  }

  /** Number of live sessions — used by /readyz and tests. */
  size(): number {
    return this.sessions.size;
  }
}
