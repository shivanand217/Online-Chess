// Per-player sliding window of recent WS round-trip samples. The median (rather than mean) is used so a
// single spike doesn't warp the compensation. Window size is small so a player whose latency improves
// mid-game stops being credited stale pings almost immediately.

export class RttTracker {
  private readonly samples = new Map<string, number[]>();

  constructor(private readonly windowSize = 11) {}

  sample(playerId: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const buf = this.samples.get(playerId) ?? [];
    buf.push(ms);
    if (buf.length > this.windowSize) buf.shift();
    this.samples.set(playerId, buf);
  }

  median(playerId: string): number | undefined {
    const buf = this.samples.get(playerId);
    if (!buf || buf.length === 0) return undefined;
    const sorted = [...buf].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1
      ? sorted[mid]
      : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }

  clear(playerId: string): void {
    this.samples.delete(playerId);
  }
}

/** Half of the median RTT, capped — the "credit back to the mover" amount applied on each move. */
export function creditFromMedian(medianMs: number | undefined, capMs: number): number {
  if (medianMs === undefined || medianMs <= 0) return 0;
  return Math.min(capMs, Math.floor(medianMs / 2));
}
