// Core domain vocabulary and pure game calculations shared across services. No side effects. Hand-written.

export type Color = 'w' | 'b';

/** Result from one player's perspective: 1 = win, 0.5 = draw, 0 = loss. */
export type GameResultScore = 0 | 0.5 | 1;

/** Expected score for `rating` vs `opponentRating` under the ELO model (0..1). */
export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/**
 * ELO rating delta to apply to `rating` after a game.
 * Self-contained: depends only on the two pre-game ratings and the result,
 * which is why a rating is always derivable from finished games.
 */
export function eloDelta(
  rating: number,
  opponentRating: number,
  score: GameResultScore,
  k = 32,
): number {
  return Math.round(k * (score - expectedScore(rating, opponentRating)));
}
