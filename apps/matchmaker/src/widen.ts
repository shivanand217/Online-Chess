// Rating window grows linearly with wait time so lonely extreme ratings eventually find anyone (or expire).
// Pure — the matchmaker loop computes a window per tick and passes it to `tryClaim`.

export interface WidenConfig {
  initialWindow: number;
  growthPerSecond: number;
  maxWindow: number;
  maxWaitMs: number;
}

export const DEFAULT_WIDEN: WidenConfig = {
  initialWindow: 50,
  growthPerSecond: 25,
  maxWindow: 800,
  maxWaitMs: 60_000,
};

export function windowFor(waitedMs: number, config: WidenConfig = DEFAULT_WIDEN): number {
  const seconds = Math.max(0, waitedMs) / 1000;
  const grown = config.initialWindow + seconds * config.growthPerSecond;
  return Math.min(config.maxWindow, Math.round(grown));
}

export function isExpired(waitedMs: number, config: WidenConfig = DEFAULT_WIDEN): boolean {
  return waitedMs >= config.maxWaitMs;
}
