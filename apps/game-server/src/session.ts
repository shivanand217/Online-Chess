// One live game. Holds the chess engine, both clocks, the generation we own, and the two client sockets.
// Clocks are server-authoritative: we never set an interval, we subtract (now - lastMoveAt) on demand
// whenever we need an up-to-date snapshot or when a move lands.
import type { ChessEngine, Color, MoveInput, Result } from '@chess/chess-engine';
import type { ParsedTimeControl } from '@chess/domain';

export type EndReason = 'checkmate' | 'stalemate' | 'draw' | 'flag' | 'resign';

export interface ClockSnapshot {
  whiteMs: number;
  blackMs: number;
}

export interface AppliedMoveState extends ClockSnapshot {
  san: string;
  uci: string;
  ply: number;
  moveNumber: number;
  turn: Color;
}

export interface SessionInit {
  gameId: string;
  whiteId: string;
  blackId: string;
  engine: ChessEngine;
  whiteMs: number;
  blackMs: number;
  turn: Color;
  generation: number;
  timeControl: ParsedTimeControl;
  /** Ply the DB already holds — the next move's ply is this value. */
  ply: number;
}

export class GameSession {
  readonly gameId: string;
  readonly whiteId: string;
  readonly blackId: string;
  readonly timeControl: ParsedTimeControl;
  readonly generation: number;
  readonly engine: ChessEngine;

  private whiteMs: number;
  private blackMs: number;
  private _turn: Color;
  private lastMoveAt: number;
  private _ply: number;
  private _status: 'active' | 'finished' = 'active';

  constructor(init: SessionInit, now: number = Date.now()) {
    this.gameId = init.gameId;
    this.whiteId = init.whiteId;
    this.blackId = init.blackId;
    this.engine = init.engine;
    this.timeControl = init.timeControl;
    this.generation = init.generation;
    this.whiteMs = init.whiteMs;
    this.blackMs = init.blackMs;
    this._turn = init.turn;
    this._ply = init.ply;
    this.lastMoveAt = now;
  }

  get turn(): Color {
    return this._turn;
  }

  get ply(): number {
    return this._ply;
  }

  get status(): 'active' | 'finished' {
    return this._status;
  }

  colorOf(playerId: string): Color | undefined {
    if (playerId === this.whiteId) return 'w';
    if (playerId === this.blackId) return 'b';
    return undefined;
  }

  /** Current clocks with the active side's elapsed time subtracted — read-only, mutates nothing. */
  snapshotClocks(now: number = Date.now()): ClockSnapshot {
    const elapsed = Math.max(0, now - this.lastMoveAt);
    if (this._turn === 'w')
      return { whiteMs: Math.max(0, this.whiteMs - elapsed), blackMs: this.blackMs };
    return { whiteMs: this.whiteMs, blackMs: Math.max(0, this.blackMs - elapsed) };
  }

  /** True once the active side's clock reaches zero. */
  flagged(now: number = Date.now()): Color | null {
    const snap = this.snapshotClocks(now);
    if (this._turn === 'w' && snap.whiteMs === 0) return 'w';
    if (this._turn === 'b' && snap.blackMs === 0) return 'b';
    return null;
  }

  /** Validate + apply a move, deduct elapsed time, add Fischer increment, flip turn, bump ply. */
  applyMove(input: MoveInput, now: number = Date.now()): AppliedMoveState {
    const mover = this._turn;
    const elapsed = Math.max(0, now - this.lastMoveAt);
    const mustSpendMs = mover === 'w' ? this.whiteMs : this.blackMs;
    if (elapsed >= mustSpendMs) {
      throw new TimeExpiredError(mover);
    }

    const applied = this.engine.move(input);

    const remaining = mustSpendMs - elapsed + this.timeControl.incrementMs;
    if (mover === 'w') this.whiteMs = remaining;
    else this.blackMs = remaining;

    this.lastMoveAt = now;
    this._turn = mover === 'w' ? 'b' : 'w';
    const movePly = this._ply;
    this._ply = movePly + 1;
    const moveNumber = Math.floor(movePly / 2) + 1;

    return {
      san: applied.san,
      uci: applied.uci,
      ply: movePly,
      moveNumber,
      turn: this._turn,
      whiteMs: this.whiteMs,
      blackMs: this.blackMs,
    };
  }

  /** Mark the session finished; the caller is responsible for persisting it. */
  finish(): void {
    this._status = 'finished';
  }

  /** Translate the engine's outcome into the DB enum pair. Returns null while the game continues. */
  terminalFromEngine(): { result: Result; reason: EndReason } | null {
    const outcome = this.engine.outcome();
    if (!outcome.over) return null;
    const reason: EndReason =
      outcome.reason === 'checkmate'
        ? 'checkmate'
        : outcome.reason === 'stalemate'
          ? 'stalemate'
          : 'draw';
    const result: Result = this.engine.result() ?? '1/2-1/2';
    return { result, reason };
  }
}

export class TimeExpiredError extends Error {
  constructor(public readonly side: Color) {
    super(`${side} is out of time`);
    this.name = 'TimeExpiredError';
  }
}
