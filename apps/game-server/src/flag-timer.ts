// Per-session timer that fires when the current mover's clock would hit zero without a move. Kept out of
// GameSession so the session stays a pure state container; the hub owns scheduling because it also owns
// the side-effects a flag triggers (DB finish + broadcast + socket close).

export class FlagTimers {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  schedule(gameId: string, delayMs: number, onFlag: () => void): void {
    this.cancel(gameId);
    // setTimeout clamps negatives + 0 to the next tick, which is the correct behaviour here (someone
    // already past their time flags on the very next event-loop turn).
    this.timers.set(gameId, setTimeout(onFlag, Math.max(0, delayMs)));
  }

  cancel(gameId: string): void {
    const timer = this.timers.get(gameId);
    if (timer) clearTimeout(timer);
    this.timers.delete(gameId);
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
