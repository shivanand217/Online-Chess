// Thin, typed wrapper around chess.js. Keeping the rest of the system behind this boundary means we can
// swap the underlying engine later without touching game-server logic — nothing outside this file imports
// chess.js. Everything the game-server needs on the hot path lives here: legal-move validation, terminal
// detection, FEN in/out, apply-move, and replay-from-moves (the basis of crash recovery). Hand-written.
import { Chess } from 'chess.js';

/** Standard starting position in FEN. */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Side to move / piece colour. */
export type Color = 'w' | 'b';

/** Board square in algebraic notation, e.g. 'e4'. */
export type Square = string;

/** A pawn may promote only to these pieces. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/** PGN-style game result from White's perspective. */
export type Result = '1-0' | '0-1' | '1/2-1/2';

/** A move as proposed by a client — the minimum needed to identify it unambiguously. */
export interface MoveInput {
  from: Square;
  to: Square;
  /** Required only when a pawn reaches the last rank. */
  promotion?: PromotionPiece;
}

/** A move after the engine has validated and applied it — everything we persist to the move log. */
export interface AppliedMove {
  from: Square;
  to: Square;
  /** Standard Algebraic Notation, e.g. 'Nf3', 'exd5', 'O-O', 'e8=Q+'. */
  san: string;
  /** Universal Chess Interface long notation, e.g. 'g1f3', 'e7e8q'. */
  uci: string;
  /** Colour that made the move. */
  color: Color;
  promotion?: PromotionPiece;
}

/**
 * Terminal state of a position. `over: false` while the game continues; when over, `reason` is the
 * granular cause and `winner` is the side that won (null for any draw). The game-server collapses the
 * three draw reasons into the DB's `end_reason = 'draw'`; the engine keeps them distinct for clarity.
 */
export type GameOutcome =
  | { over: false }
  | {
      over: true;
      reason: 'checkmate' | 'stalemate' | 'threefold' | 'insufficient' | 'fifty-move';
      winner: Color | null;
    };

/** Thrown by {@link ChessEngine.move} when a proposed move is not legal in the current position. */
export class IllegalMoveError extends Error {
  constructor(public readonly attempted: MoveInput) {
    super(`illegal move: ${attempted.from}${attempted.to}${attempted.promotion ?? ''}`);
    this.name = 'IllegalMoveError';
  }
}

/**
 * Authoritative chess position. Wraps a single chess.js instance and exposes only our own types, so
 * callers depend on this contract rather than on chess.js. Instances are mutable: `move` advances the
 * position in place, matching the in-memory game-server session that owns one engine per live game.
 */
export class ChessEngine {
  private readonly board: Chess;

  /** Start a game at the standard position, or resume one from a FEN. Throws on an invalid FEN. */
  constructor(fen: string = START_FEN) {
    this.board = new Chess(fen);
  }

  /**
   * Rebuild a position by replaying moves (SAN or UCI strings) onto a starting FEN. This is exactly what
   * a replacement game-server does during crash recovery: load the Game row, replay its move log, resume.
   * Throws {@link IllegalMoveError} if any move in the sequence is illegal — a corrupt or tampered log
   * must fail loudly rather than silently diverge from the real game.
   */
  static replay(moves: readonly string[], fen: string = START_FEN): ChessEngine {
    const engine = new ChessEngine(fen);
    for (const move of moves) {
      try {
        engine.board.move(move);
      } catch {
        throw new IllegalMoveError({ from: move.slice(0, 2), to: move.slice(2, 4) });
      }
    }
    return engine;
  }

  /** Current position as FEN — the compact snapshot sent to clients on (re)connect via `gameState`. */
  fen(): string {
    return this.board.fen();
  }

  /** Whose turn it is to move. */
  turn(): Color {
    return this.board.turn();
  }

  /** Full-move number (increments after Black's move), matching the client's `moveNumber`. */
  moveNumber(): number {
    return this.board.moveNumber();
  }

  /** Is the side to move currently in check? */
  inCheck(): boolean {
    return this.board.inCheck();
  }

  /**
   * All legal moves in the current position, or only those from `square` when given. Used for client
   * hints and, later, premove validation — never on the authoritative move path, which uses {@link move}.
   */
  legalMoves(square?: Square): MoveInput[] {
    const verbose = square
      ? this.board.moves({ square: square as never, verbose: true })
      : this.board.moves({ verbose: true });
    return verbose.map((m) => ({
      from: m.from,
      to: m.to,
      ...(m.promotion ? { promotion: m.promotion as PromotionPiece } : {}),
    }));
  }

  /** Whether a proposed move is legal, without mutating the position. */
  isLegal(input: MoveInput): boolean {
    const probe = new Chess(this.board.fen());
    try {
      probe.move(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate and apply a move, advancing the position. Returns the fully-resolved move (SAN + UCI) to
   * append to the durable move log. Throws {@link IllegalMoveError} if the move is not legal — the
   * game-server turns that into a rejected `moveAck` rather than mutating or broadcasting anything.
   */
  move(input: MoveInput): AppliedMove {
    let result;
    try {
      result = this.board.move(input);
    } catch {
      throw new IllegalMoveError(input);
    }
    return {
      from: result.from,
      to: result.to,
      san: result.san,
      uci: `${result.from}${result.to}${result.promotion ?? ''}`,
      color: result.color,
      ...(result.promotion ? { promotion: result.promotion as PromotionPiece } : {}),
    };
  }

  /**
   * Terminal state of the current position. Order matters: the specific draw kinds are checked before the
   * catch-all so `fifty-move` is only reported once threefold and insufficient material are ruled out.
   */
  outcome(): GameOutcome {
    if (this.board.isCheckmate()) {
      // The side to move has been mated, so the other side won.
      return { over: true, reason: 'checkmate', winner: this.board.turn() === 'w' ? 'b' : 'w' };
    }
    if (this.board.isStalemate()) return { over: true, reason: 'stalemate', winner: null };
    if (this.board.isInsufficientMaterial())
      return { over: true, reason: 'insufficient', winner: null };
    if (this.board.isThreefoldRepetition())
      return { over: true, reason: 'threefold', winner: null };
    if (this.board.isDraw()) return { over: true, reason: 'fifty-move', winner: null };
    return { over: false };
  }

  /** PGN-style result string for a finished game, or null while it continues. */
  result(): Result | null {
    const o = this.outcome();
    if (!o.over) return null;
    if (o.winner === 'w') return '1-0';
    if (o.winner === 'b') return '0-1';
    return '1/2-1/2';
  }
}

/**
 * Count leaf nodes of the move tree to `depth` from a position — the standard **perft** move-generation
 * correctness check. Exact node counts from the start position are widely published, so matching them
 * proves our legal-move generation is sound.
 */
export function perft(depth: number, fen: string = START_FEN): number {
  return perftFrom(new Chess(fen), depth);
}

function perftFrom(board: Chess, depth: number): number {
  if (depth === 0) return 1;
  const moves = board.moves({ verbose: true });
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) {
    board.move(m);
    nodes += perftFrom(board, depth - 1);
    board.undo();
  }
  return nodes;
}
