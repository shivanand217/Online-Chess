# 00 — Requirements & Capacity

## Functional requirements (in scope)

1. **Matchmaking** — players find an opponent through skill-based (ELO)
   matchmaking on a chosen time control, and a game is created for them.
2. **Real-time play** — two players play a game in real time, with the **server
   as the single source of truth** for the board and both clocks.
3. **Leaderboard** — a global leaderboard plus each player's own rank, updating
   shortly after games finish.

### Below the line (explicitly out of scope)

- Spectating / broadcasting popular games.
- In-game chat, friends, social graph.
- Puzzles, training, post-game analysis / replay UI.
- Tournaments and arena play.
- Anti-cheat / engine-detection (interesting but a separate offline ML system).

We name these to show product sense, then design none of them. A few are picked
up as **stretch goals** in [Phase 9](04-project-plan.md#phase-9--stretch--below-the-line).

---

## Non-functional requirements

| # | Requirement | Target |
|---|-------------|--------|
| NFR-1 | **Low-latency move propagation** | p99 end-to-end move → opponent's board **< 200 ms** |
| NFR-2 | **Consistency over availability for game state** | On unreachable game server, **pause** the game (recoverable) rather than let two clients drift (corrupt) |
| NFR-3 | **Scale** | 500K concurrent games = **1M concurrent WS connections** at peak |
| NFR-4 | **Clock fairness** | Network transit must not systematically penalize distant players |

### Below the line (NFR)

- Account security / abuse beyond fair-play.
- GDPR / data-privacy compliance.
- (We *do* build monitoring, CI/CD, and zero-downtime deploys — they're core to
  the "production-grade" goal of this project, unlike the reference design where
  they were out of scope.)

---

## Scale & capacity estimation

Scale drives every design decision, so we pin the numbers first.

### Connections & games

```
Peak concurrent games ............ 500,000
Connections per game ............. 2 (one WS per player)
Peak concurrent WS connections ... 1,000,000
```

### Matchmaking request rate

Most chess is bullet/blitz, ~120 s per game, and players re-queue immediately.

```
Active players in games .......... ~1,000,000
Re-queue cadence ................. every ~120 s
Steady-state match requests ...... 1,000,000 / 120 ≈ 8,300 req/s
With fresh arrivals + peaks ...... ~30,000 req/s (design headroom)
```

Redis op budget for matchmaking (see [LLD](02-lld.md#matchmaking)):

```
~30K req/s × ~4 Redis ops/req .... ~120K ops/s total
Busiest single time control ...... ~40% → ~50K ops/s on the hottest key
Single Redis node capacity ....... low hundreds of K sorted-set ops/s
Conclusion ....................... hottest key < 1/3 of one node → NO sharding
```

### Game-server move throughput

```
Moves per game (blitz avg) ....... ~40
Game duration .................... ~120 s
Move rate per game ............... 40 / 120 ≈ 0.33 moves/s
Total move rate .................. 500K × 0.33 ≈ 165,000 moves/s
```

Each move is an in-memory validation + a single async move-log append. The
200 ms budget easily absorbs the few-ms synchronous persist we do **before**
broadcast (durability ordering — see LLD).

### Game-server fleet sizing

A box holds tens of thousands of *idle* sockets, but a live game server also
validates moves and runs clocks, so realistic per-node game counts are lower.

```
Assume ~5,000–10,000 live games per node (2 conns each, plus validation/clocks)
Fleet size ....................... 500K / 7.5K ≈ 65–100 game-server pods
```

Dozens to low-hundreds of pods — a fleet, not a monolith. This is why
routing + crash recovery are the crux of the design.

### Storage

```
Players .......................... 10,000,000 rows (leaderboard scale)
Game row ......................... ~200 bytes (clocks, turn, result, ratings)
Moves ............................ ~40 rows/game, a few hundred bytes total
Finished games kept forever ...... archive is a separate data-at-rest problem
```

Leaderboard Redis sorted set: 10M members ≈ **~1 GB**, single instance, no shard.

---

## What "production-grade at portfolio scale" means

We are honest about the gap between design target and what runs on a laptop or a
small GKE cluster:

- **Design** every component for 1M connections (stateless workers, sharded-ready
  keys we prove we don't need to shard, horizontal game-server fleet).
- **Validate** proportionally: e.g. 10K–50K simulated connections via k6, then
  extrapolate against the capacity math above.
- **Prove the hard invariants** for real — race-free matchmaking claim, crash
  recovery via replay, generation fencing, latency compensation — since those are
  correctness properties, not throughput properties, and must hold at any scale.

See [Phase 8](04-project-plan.md#phase-8--resilience-load--chaos) for the
validation plan.
