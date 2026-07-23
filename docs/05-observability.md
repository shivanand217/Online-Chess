# 05 — Observability & SLOs

We can't run the scale/chaos work of Phase 8 blind, so observability lands in
Phase 5, right after the core game. Three pillars — metrics, traces, logs —
unified by OpenTelemetry and correlation IDs.

## SLOs (what we actually promise)

| SLO | Target | Measured by |
|---|---|---|
| **Move propagation latency** | p99 < 200 ms (end-to-end move → opponent board) | `move_propagation_ms` histogram |
| **Gameplay availability** | 99.9% of active games not force-terminated by our failure | successful-game ratio |
| **Match wait time** | p95 < a tuned budget per time control | `matchmaking_wait_ms` histogram |
| **Leaderboard freshness** | rating reflected < 5 s after game end | `elo_apply_lag_ms` |

Alerts are **multi-window burn-rate** on these SLOs, not raw threshold spam.

## Metrics

### RED per service (all services)
- **Rate** — requests/messages per second.
- **Errors** — error ratio (HTTP 5xx, WS protocol errors, rejected moves by
  reason).
- **Duration** — latency histograms (REST handlers, move handling, apply step).

### Domain metrics (the ones that make this chess)

| Metric | Type | Service | Why it matters |
|---|---|---|---|
| `matchmaking_pool_size{timeControl}` | gauge | matchmaker | queue depth → KEDA scaling + wait insight |
| `matchmaking_wait_ms` | histogram | matchmaker | fairness of the widening policy |
| `matchmaking_claim_contention` | counter | matchmaker | `ZREM`-returned-0 rate → hot-band pressure |
| `active_games` | gauge | game-server | fleet load, per-node game count |
| `ws_connections` | gauge | game-server | connection density vs node budget |
| `move_propagation_ms` | histogram | game-server | **the NFR-1 SLO** |
| `move_validation_ms` | histogram | game-server | in-memory hot-path health |
| `move_persist_ms` | histogram | game-server | the pre-broadcast durable write |
| `clock_compensation_ms` | histogram | game-server | latency-comp effect + cap saturation |
| `game_recoveries_total{reason}` | counter | game-server | crash/reassign churn |
| `fence_rejections_total` | counter | game-server | zombie writes stopped (should be rare) |
| `elo_apply_lag_ms` | histogram | leaderboard | leaderboard freshness SLO |
| `leaderboard_drift` | gauge | leaderboard | reconciliation health (should be ~0) |

### Infra (USE)
Utilization / Saturation / Errors on pods, nodes, Postgres (connections, replica
lag), Redis (ops/s, memory, `ZADD`/`ZREM` rates), etcd (watch latency, lease
churn).

## Traces (OpenTelemetry)

Auto-instrumentation for Fastify, `pg`/Drizzle, ioredis, and the WS layer, plus
manual spans on the interesting steps.

- **Match trace:** `POST /matchmaking` → enqueue → worker find → claim → create
  game → pub/sub notify → long-poll complete. One trace across gateway +
  matchmaker, so a slow match is attributable to find vs claim vs notify.
- **Move trace:** `sendMove` → validate → apply → persist → broadcast. Shows
  exactly where the 200 ms budget goes; the persist span proves it's off the
  critical latency even though it's synchronous.
- **Game-end trace:** result write → apply step → `players.rating` + sorted-set
  writes → `gameEnd` push.

Trace context propagates over WS connect params and Redis pub/sub messages via a
carried `traceparent`, so a game's whole life is one linked story.

## Logs (Pino → Loki)

- Structured JSON, one logger per service, child loggers bound to
  `{ gameId, playerId, requestId, traceId }`.
- `traceId`/`spanId` injected from the active OTel context → click from a Grafana
  panel to the exact logs.
- Levels: `info` for lifecycle, `warn` for recoverable (fence rejection, requeue),
  `error` for genuine faults. No move-by-move spam at `info` in prod (sampled).

## Dashboards (Grafana)

1. **System overview** — active games, connections, match rate, move p99, error
   ratios, fleet size.
2. **Matchmaking** — pool sizes per time control, wait-time percentiles, claim
   contention, requeue rate.
3. **Game fleet** — per-node games/connections, move latency breakdown
   (validate/persist/propagate), recoveries, fence rejections.
4. **Clocks & fairness** — compensation applied, cap saturation, RTT medians.
5. **Leaderboard** — apply lag, drift, top-N cache hit rate.
6. **Infra** — Postgres, Redis, etcd, node/pod USE.

## Health & lifecycle

- `/healthz` — **liveness**: process is up (cheap, no deps).
- `/readyz` — **readiness**: dependencies reachable (DB, Redis, etcd, registered in
  ring). Game servers report *not ready* while draining.
- **Graceful shutdown** (critical for the stateful fleet): on SIGTERM a game
  server deregisters its etcd node, stops accepting new games, lets in-flight
  games finish or checkpoints them (they're recoverable via replay anyway), drains
  WS connections, then exits. This is what makes rolling deploys drop zero games.

## Alerting (starter set)

| Alert | Condition |
|---|---|
| Move latency SLO burn | `move_propagation_ms` p99 > 200 ms, multi-window burn |
| Match starvation | `matchmaking_wait_ms` p95 over budget for 5m |
| Fence storm | `fence_rejections_total` rate spikes (partition / split-brain) |
| Recovery churn | `game_recoveries_total` rate high (flapping nodes) |
| Leaderboard drift | `leaderboard_drift` > 0 after reconciliation |
| Redis saturation | Redis ops/s or memory approaching node limits |
| Postgres replica lag | leaderboard read replica lag high |
