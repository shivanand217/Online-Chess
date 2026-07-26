// Core domain vocabulary and pure game calculations shared across services. No side effects. Hand-written.

/** Side to move / piece colour. */
export type Color = 'w' | 'b';

/** The colour opposite `color`. */
export function opponent(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** PGN-style game result from White's perspective. */
export type Result = '1-0' | '0-1' | '1/2-1/2';

/** Result from one player's perspective: 1 = win, 0.5 = draw, 0 = loss. */
export type GameResultScore = 0 | 0.5 | 1;

/** Default rating assigned to a new player (matches the `players.rating` column default). */
export const INITIAL_RATING = 1500;

// --- ELO ---------------------------------------------------------------------------------------------

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

/** White's score for a given result — the bridge from a PGN result to the ELO model. */
export function scoreForWhite(result: Result): GameResultScore {
  if (result === '1-0') return 1;
  if (result === '0-1') return 0;
  return 0.5;
}

/**
 * Both players' rating deltas for a finished game, computed from the pre-game ratings snapshotted on the
 * Game row. This is exactly what the leaderboard apply step fans into `players.rating` and the Redis
 * sorted set — and, because it depends only on the snapshot + result, re-running it is deterministic
 * (the basis of the idempotent apply and the reconciliation rebuild).
 */
export function ratingChange(
  whiteRating: number,
  blackRating: number,
  result: Result,
  k = 32,
): { whiteDelta: number; blackDelta: number } {
  const whiteScore = scoreForWhite(result);
  const blackScore = (1 - whiteScore) as GameResultScore;
  return {
    whiteDelta: eloDelta(whiteRating, blackRating, whiteScore, k),
    blackDelta: eloDelta(blackRating, whiteRating, blackScore, k),
  };
}

// --- Time control ------------------------------------------------------------------------------------

/** Canonical speed category, derived from the estimated game duration. */
export type TimeCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

/** A time control parsed into machine-usable durations (every clock in the system is milliseconds). */
export interface ParsedTimeControl {
  /** The exact identifier string, e.g. 'blitz-3-2' — also the Redis matchmaking pool key. */
  raw: string;
  /** The label as written in the identifier (`blitz` in `blitz-3-2`); may differ from `category`. */
  label: string;
  /** Canonical category computed from the actual durations (authoritative over the label). */
  category: TimeCategory;
  /** Starting time on each player's clock. */
  initialMs: number;
  /** Time added to the mover's clock after each move (Fischer increment). */
  incrementMs: number;
}

/**
 * Classify a time control by estimated duration, following the common convention of
 * `base + 40 × increment` (a typical game length). Thresholds mirror the widely-used speed tiers.
 */
export function classifyTimeControl(
  initialSeconds: number,
  incrementSeconds: number,
): TimeCategory {
  const estimatedSeconds = initialSeconds + 40 * incrementSeconds;
  if (estimatedSeconds < 180) return 'bullet';
  if (estimatedSeconds < 480) return 'blitz';
  if (estimatedSeconds < 1500) return 'rapid';
  return 'classical';
}

const TIME_CONTROL_RE = /^([a-z]+)-(\d+)-(\d+)$/;

/**
 * Parse a time-control identifier like `blitz-3-2` (3 minutes base + 2 second increment) into durations.
 * The first number is minutes, the second is the per-move increment in seconds. Throws on a malformed
 * identifier or a degenerate 0+0 control (no time to play). Lives in the domain so the client and every
 * service agree on exactly what a time control means.
 */
export function parseTimeControl(raw: string): ParsedTimeControl {
  const match = TIME_CONTROL_RE.exec(raw);
  if (!match) throw new Error(`invalid time control: ${raw}`);
  const [, label = '', minutesStr = '0', incrementStr = '0'] = match;
  const initialSeconds = Number(minutesStr) * 60;
  const incrementSeconds = Number(incrementStr);
  if (initialSeconds === 0 && incrementSeconds === 0) {
    throw new Error(`degenerate time control (0+0): ${raw}`);
  }
  return {
    raw,
    label,
    category: classifyTimeControl(initialSeconds, incrementSeconds),
    initialMs: initialSeconds * 1000,
    incrementMs: incrementSeconds * 1000,
  };
}
