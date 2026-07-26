import { describe, it, expect } from 'vitest';
import { ChessEngine, IllegalMoveError, START_FEN, perft, type MoveInput } from './index.js';

/** Apply a sequence of {from,to} coordinate moves, returning the engine for chaining assertions. */
function play(moves: MoveInput[], fen?: string): ChessEngine {
  const engine = new ChessEngine(fen);
  for (const m of moves) engine.move(m);
  return engine;
}

const c = (from: string, to: string, promotion?: MoveInput['promotion']): MoveInput => ({
  from,
  to,
  ...(promotion ? { promotion } : {}),
});

describe('perft — move-generation correctness from the start position', () => {
  // Published leaf-node counts; matching all four proves legal-move generation is sound.
  const cases: Array<[depth: number, nodes: number]> = [
    [1, 20],
    [2, 400],
    [3, 8902],
    [4, 197281],
  ];
  it.each(cases)(
    'perft(%i) = %i',
    (depth, nodes) => {
      expect(perft(depth)).toBe(nodes);
    },
    60_000,
  );
});

describe('terminal detection', () => {
  it('detects checkmate and awards the win to the mating side (fool’s mate → Black)', () => {
    // 1. f3 e5 2. g4 Qh4#
    const engine = play([c('f2', 'f3'), c('e7', 'e5'), c('g2', 'g4'), c('d8', 'h4')]);
    expect(engine.outcome()).toEqual({ over: true, reason: 'checkmate', winner: 'b' });
    expect(engine.result()).toBe('0-1');
    expect(engine.inCheck()).toBe(true);
  });

  it('detects checkmate for White (scholar’s mate → White)', () => {
    // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
    const engine = play([
      c('e2', 'e4'),
      c('e7', 'e5'),
      c('f1', 'c4'),
      c('b8', 'c6'),
      c('d1', 'h5'),
      c('g8', 'f6'),
      c('h5', 'f7'),
    ]);
    expect(engine.outcome()).toEqual({ over: true, reason: 'checkmate', winner: 'w' });
    expect(engine.result()).toBe('1-0');
  });

  it('detects stalemate as a draw with no winner', () => {
    // Black king h8, White Qf7 + Kg6: Black is not in check but has no legal move.
    const engine = new ChessEngine('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(engine.outcome()).toEqual({ over: true, reason: 'stalemate', winner: null });
    expect(engine.result()).toBe('1/2-1/2');
    expect(engine.inCheck()).toBe(false);
    expect(engine.legalMoves()).toHaveLength(0);
  });

  it('detects insufficient material (K vs K) as a draw', () => {
    const engine = new ChessEngine('k7/8/8/8/8/8/8/K7 w - - 0 1');
    expect(engine.outcome()).toEqual({ over: true, reason: 'insufficient', winner: null });
  });

  it('reports over: false for an ongoing position', () => {
    expect(new ChessEngine().outcome()).toEqual({ over: false });
    expect(new ChessEngine().result()).toBeNull();
  });
});

describe('apply-move', () => {
  it('resolves SAN and UCI for a normal move', () => {
    const applied = new ChessEngine().move(c('e2', 'e4'));
    expect(applied).toMatchObject({ from: 'e2', to: 'e4', san: 'e4', uci: 'e2e4', color: 'w' });
  });

  it('encodes promotion in UCI and the applied move', () => {
    const applied = new ChessEngine('k6K/4P3/8/8/8/8/8/8 w - - 0 1').move(c('e7', 'e8', 'q'));
    expect(applied.uci).toBe('e7e8q');
    expect(applied.promotion).toBe('q');
  });

  it('rejects an illegal move without mutating the position', () => {
    const engine = new ChessEngine();
    const before = engine.fen();
    expect(() => engine.move(c('e2', 'e5'))).toThrow(IllegalMoveError);
    expect(engine.fen()).toBe(before);
    expect(engine.turn()).toBe('w');
  });

  it('isLegal probes without mutating', () => {
    const engine = new ChessEngine();
    expect(engine.isLegal(c('e2', 'e4'))).toBe(true);
    expect(engine.isLegal(c('e2', 'e5'))).toBe(false);
    expect(engine.fen()).toBe(START_FEN);
  });
});

describe('legal moves', () => {
  it('lists 20 moves from the start position', () => {
    expect(new ChessEngine().legalMoves()).toHaveLength(20);
  });

  it('lists moves from a single square', () => {
    const froms = new ChessEngine().legalMoves('e2');
    expect(froms.map((m) => m.to).sort()).toEqual(['e3', 'e4']);
  });
});

describe('replay — the crash-recovery path', () => {
  it('rebuilds a position from a UCI move log', () => {
    const engine = ChessEngine.replay(['e2e4', 'e7e5', 'g1f3']);
    expect(engine.turn()).toBe('b');
    expect(engine.moveNumber()).toBe(2);
    // Same position reached by applying the moves directly.
    const direct = play([c('e2', 'e4'), c('e7', 'e5'), c('g1', 'f3')]);
    expect(engine.fen()).toBe(direct.fen());
  });

  it('throws on a corrupt/illegal move log rather than diverging silently', () => {
    expect(() => ChessEngine.replay(['e2e4', 'e7e5', 'e1e8'])).toThrow(IllegalMoveError);
  });
});
