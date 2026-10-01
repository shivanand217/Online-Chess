// Pure domain primitives: colour, result, ELO, time-control parsing. No I/O, shared by every service.

export type Color = 'w' | 'b';

export function opponent(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** PGN-style game result from White's perspective. */
export type Result = '1-0' | '0-1' | '1/2-1/2';

/** 1 = win, 0.5 = draw, 0 = loss. */
export type GameResultScore = 0 | 0.5 | 1;

export const INITIAL_RATING = 1500;

// --- ELO ---------------------------------------------------------------------------------------------

export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

/** Depends only on the two pre-game ratings and the result — which is why a rating is always derivable
 *  from the finished-game history. */
export function eloDelta(
  rating: number,
  opponentRating: number,
  score: GameResultScore,
  k = 32,
): number {
  return Math.round(k * (score - expectedScore(rating, opponentRating)));
}

export function scoreForWhite(result: Result): GameResultScore {
  if (result === '1-0') return 1;
  if (result === '0-1') return 0;
  return 0.5;
}

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

export type TimeCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

/** A time control parsed into milliseconds. */
export interface ParsedTimeControl {
  raw: string;
  label: string;
  category: TimeCategory;
  initialMs: number;
  incrementMs: number;
}

/** Standard tier split by estimated duration (base + 40 × increment). */
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

/** Parse e.g. `blitz-3-2` → 3 minutes base + 2s Fischer increment. Throws on malformed or 0+0. */
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
