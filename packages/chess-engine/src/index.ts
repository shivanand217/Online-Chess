// Thin typed wrapper around chess.js. Keeping the rest of the codebase behind this boundary means we can
// swap engines later without touching game-server logic. Everything on the hot path lives here: legal
// moves, terminal detection, FEN in/out, apply-move, and replay (used for crash recovery).
import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export type Color = 'w' | 'b';
export type Square = string;
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';
export type Result = '1-0' | '0-1' | '1/2-1/2';

export interface MoveInput {
  from: Square;
  to: Square;
  promotion?: PromotionPiece;
}

export interface AppliedMove {
  from: Square;
  to: Square;
  san: string;
  uci: string;
  color: Color;
  promotion?: PromotionPiece;
}

export type GameOutcome =
  | { over: false }
  | {
      over: true;
      reason: 'checkmate' | 'stalemate' | 'threefold' | 'insufficient' | 'fifty-move';
      winner: Color | null;
    };

export class IllegalMoveError extends Error {
  constructor(public readonly attempted: MoveInput) {
    super(`illegal move: ${attempted.from}${attempted.to}${attempted.promotion ?? ''}`);
    this.name = 'IllegalMoveError';
  }
}

/** One engine per live game. Mutable: `move` advances the position in place. */
export class ChessEngine {
  private readonly board: Chess;

  constructor(fen: string = START_FEN) {
    this.board = new Chess(fen);
  }

  /** Rebuild a position by replaying SAN/UCI strings — the crash-recovery path. Throws loudly on any
   *  illegal move in the sequence rather than silently diverging. */
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

  fen(): string {
    return this.board.fen();
  }

  turn(): Color {
    return this.board.turn();
  }

  moveNumber(): number {
    return this.board.moveNumber();
  }

  inCheck(): boolean {
    return this.board.inCheck();
  }

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

  isLegal(input: MoveInput): boolean {
    const probe = new Chess(this.board.fen());
    try {
      probe.move(input);
      return true;
    } catch {
      return false;
    }
  }

  /** Validate + apply, returning the resolved move for the durable log. */
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

  outcome(): GameOutcome {
    if (this.board.isCheckmate()) {
      // Side to move has been mated → the other side won.
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

  result(): Result | null {
    const o = this.outcome();
    if (!o.over) return null;
    if (o.winner === 'w') return '1-0';
    if (o.winner === 'b') return '0-1';
    return '1/2-1/2';
  }
}

/** Standard perft (count leaf nodes to `depth`). Matching the published counts proves move-gen is sound. */
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
