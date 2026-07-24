# 03 — Tech Stack

Every choice with its rationale and the alternative we rejected. Opinionated on
purpose — these are the defaults; a `[decision needed]` tag marks the few worth
confirming before Phase 0.

## Language & runtime

| Choice                                       | Why                                                                                                              | Rejected                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Node.js 22 LTS** (ESM)                     | Current LTS, stable `node:` core, native test runner available but we use Vitest; great for I/O-bound WS fan-out | Node 20 (older LTS), Bun/Deno (less battle-tested for this at scale) |
| **TypeScript (strict)**                      | Type-safe protocol shared client↔server; catches contract drift                                                  | Plain JS                                                             |
| **tsx / esbuild** for dev, **tsc** for types | Fast reloads, fast builds                                                                                        | ts-node (slow)                                                       |

## Monorepo

| Choice              | Why                                                                 | Rejected                                 |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| **pnpm workspaces** | Fast, strict, content-addressed store; best for many small packages | npm/yarn workspaces (slower, looser)     |
| **Turborepo**       | Task graph + remote caching for `build/test/lint`; simple           | Nx (heavier), plain scripts (no caching) |

## Services / frameworks

| Concern                    | Choice                                 | Why                                                                                           | Rejected                                                                                           |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| REST edge (gateway)        | **Fastify**                            | Fastest mainstream Node HTTP framework; schema-based validation, plugins, first-class logging | Express (slower, no schema), NestJS (heavier abstraction)                                          |
| Game-server WebSockets     | **uWebSockets.js** `[decision needed]` | C++-backed, handles the tens-of-thousands-of-connections-per-node target with low memory      | `ws` (simpler, fine at portfolio scale — good fallback), Socket.IO (protocol overhead, not needed) |
| Matchmaker / apply workers | plain Node services                    | stateless loops over Redis; no framework needed                                               | —                                                                                                  |

> **`ws` vs uWebSockets.js:** we design the WS layer behind a thin adapter in
> `packages/protocol` so we can start on `ws` (trivial local dev) and swap to
> uWebSockets.js when we push connection density in Phase 8, without touching game
> logic.

## Data & messaging

| Concern              | Choice                                             | Why                                                                                           | Rejected                                                                                                          |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source of truth      | **PostgreSQL 16** (Cloud SQL in prod)              | Relational integrity, transactional move+clock write, btree for top-N                         | —                                                                                                                 |
| DB access            | **Drizzle ORM** `[decision needed]`                | Thin, SQL-first, great TS types, no heavy runtime/engine, easy raw SQL for the fencing UPDATE | Prisma (heavier, its own query engine — good DX but less SQL control), raw `pg` (more boilerplate)                |
| Migrations           | **drizzle-kit**                                    | Co-located with schema                                                                        | Flyway/Liquibase (JVM)                                                                                            |
| Redis client         | **ioredis**                                        | Mature, Lua `defineCommand`, cluster support, pub/sub                                         | node-redis (fine; ioredis has richer Lua/cluster ergonomics)                                                      |
| Redis usage          | matchmaking pool + pub/sub; leaderboard sorted set | native sorted sets = the whole design                                                         | —                                                                                                                 |
| Game-server registry | **etcd** `[decision needed]`                       | Lightweight, k8s-native, lease-based ephemeral keys + watch = the membership ring             | ZooKeeper (heavier/JVM), Consul (more than we need), Redis-based (simpler fallback but weaker liveness semantics) |

## Domain

| Concern           | Choice                                          | Why                                                                                                         |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Chess rules       | **chess.js** wrapped in `packages/chess-engine` | Battle-tested legal-move gen, check/checkmate/stalemate/draw, FEN/PGN; wrapping keeps us free to swap later |
| Validation / DTOs | **zod**                                         | One schema → runtime validation + inferred TS types, shared across services                                 |
| ELO               | small pure module in `packages/domain`          | Deterministic, unit-testable, self-contained per game                                                       |
| Auth              | **jose** (JWT)                                  | Standards-based JWT verify at the edge; identity never trusted from body                                    |

## Observability

| Concern           | Choice                                                | Why                                                                                                     |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Tracing + metrics | **OpenTelemetry SDK**                                 | Vendor-neutral, auto-instrumentation for Fastify/pg/ioredis; traces span gateway→matchmaker→game-server |
| Metrics backend   | **Prometheus** → **Grafana**                          | Standard; RED + domain metrics; `/metrics` per service                                                  |
| Traces backend    | **Tempo** (or Jaeger locally)                         | Grafana-native trace store                                                                              |
| Logs              | **Pino** → **Loki**                                   | Fastest structured JSON logger; correlation IDs from OTel context                                       |
| Alerting          | **Alertmanager** (local) / **Cloud Monitoring** (GCP) | SLO burn-rate alerts                                                                                    |

## Packaging & infra

| Concern             | Choice                                           | Why                                                                           |
| ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Containers          | **Docker**, multi-stage → **distroless** runtime | Small, non-root, minimal attack surface                                       |
| Local orchestration | **docker-compose**                               | One-command full stack (pg, redis, etcd, prometheus, grafana, tempo)          |
| Orchestration       | **Kubernetes** (GKE)                             | The target; HPA + affinity for WS                                             |
| K8s packaging       | **Helm** (chart per service) + values per env    | Templating, releases, rollbacks                                               |
| IaC                 | **Terraform**                                    | GKE, Cloud SQL, Memorystore, Artifact Registry, networking, Workload Identity |
| CI/CD               | **GitHub Actions**                               | lint/typecheck/test/build → push to Artifact Registry → deploy to GKE         |
| Load testing        | **k6**                                           | Scriptable, WS + HTTP, high concurrency from one binary                       |
| Autoscaling         | **HPA** + **KEDA**                               | HPA on CPU/conns; KEDA on Redis queue depth for matchmaker                    |

## GCP services (prod)

| Need       | GCP service                                                                     |
| ---------- | ------------------------------------------------------------------------------- |
| Kubernetes | **GKE** (Autopilot for simplicity, or Standard for node control over WS pods)   |
| Postgres   | **Cloud SQL for PostgreSQL** (+ read replica for leaderboard reads)             |
| Redis      | **Memorystore for Redis** (HA tier, or self-hosted + Sentinel for full control) |
| Images     | **Artifact Registry**                                                           |
| L7 (REST)  | **Cloud Load Balancing** (HTTPS LB + managed cert)                              |
| L4/WS      | **TCP proxy / passthrough LB** with session affinity for sticky game sockets    |
| Secrets    | **Secret Manager** (+ External Secrets Operator)                                |
| Identity   | **Workload Identity** (no static keys in pods)                                  |

## Testing

| Level       | Tool                                                             |
| ----------- | ---------------------------------------------------------------- |
| Unit        | **Vitest** (engine perft, ELO, matchmaking claim, fencing)       |
| Integration | Vitest + **Testcontainers** (real Postgres/Redis/etcd in Docker) |
| Contract    | zod schemas shared; snapshot the WS protocol                     |
| Load / soak | **k6**                                                           |
| Chaos       | pod kills, `tc netem` latency, Redis/Cloud SQL failover drills   |

---

## Decisions to confirm before Phase 0

These three meaningfully shape the code; the recommended default is bolded above.
Everything else we proceed with as written.

1. **WebSocket lib** — `ws` (simple) vs **uWebSockets.js** (density). We can start
   on `ws` behind an adapter and swap later.
2. **DB access** — **Drizzle** (SQL-first) vs Prisma (DX-first).
3. **Membership registry** — **etcd** vs a simpler Redis-based registry to avoid a
   third stateful dependency early.
