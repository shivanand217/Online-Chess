// Thin, typed wrapper around chess.js. Keeping the rest of the system behind this boundary means we can
// swap the underlying engine later without touching game-server logic. Full API arrives in Phase 1. Hand-written.
import { Chess } from 'chess.js';

export type { Move } from 'chess.js';

/** Create a fresh board, optionally from a FEN position. */
export function createBoard(fen?: string): Chess {
  return fen ? new Chess(fen) : new Chess();
}

/** Rebuild board state by replaying SAN/UCI moves — the basis of crash recovery. */
export function replay(moves: string[], fen?: string): Chess {
  const board = createBoard(fen);
  for (const move of moves) board.move(move);
  return board;
}
