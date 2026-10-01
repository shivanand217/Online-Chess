// Widening-window policy. A lonely extreme-rating waiter would never match against a narrow band, so we
// grow the rating window the longer they've waited. Pure function — no I/O here — so the policy is
// trivially unit-tested and tunable. The matchmaker loop reads this on each tick to decide the window
// to pass to `tryClaim`, and the gateway's long-poll uses `isExpired` to decide when to 408. Hand-written.

export interface WidenConfig {
  /** Starting ±window in ELO points. Narrow enough that early matches are competitive. */
  initialWindow: number;
  /** Extra ±window per second of wait (ramp). */
  growthPerSecond: number;
  /** Hard cap on the window so an extreme rating eventually matches anyone (or expires). */
  maxWindow: number;
  /** How long a waiter is allowed to sit in the pool before the gateway should expire the request. */
  maxWaitMs: number;
}

/** Sensible defaults for Phase 2 — tune via metrics in Phase 5. */
export const DEFAULT_WIDEN: WidenConfig = {
  initialWindow: 50,
  growthPerSecond: 25,
  maxWindow: 800,
  maxWaitMs: 60_000,
};

/**
 * The ± rating window to search for `waitedMs` of elapsed waiting time. Monotonically non-decreasing;
 * clamped to `maxWindow`. Negative `waitedMs` is treated as zero so a clock skew can never shrink below
 * the initial band.
 */
export function windowFor(waitedMs: number, config: WidenConfig = DEFAULT_WIDEN): number {
  const seconds = Math.max(0, waitedMs) / 1000;
  const grown = config.initialWindow + seconds * config.growthPerSecond;
  return Math.min(config.maxWindow, Math.round(grown));
}

/** True once the waiter has been in the pool longer than the configured max wait. */
export function isExpired(waitedMs: number, config: WidenConfig = DEFAULT_WIDEN): boolean {
  return waitedMs >= config.maxWaitMs;
}
