# Chess

A real-time online chess platform I'm building in TypeScript. Players sign in,
get matched against someone of a similar rating, play a timed game over a
WebSocket, and show up on a global leaderboard afterwards. The repo is a pnpm
monorepo with a handful of small services, a shared chess engine, a Postgres
schema, and Redis for the parts that need fast shared state.

## What's in here

- A matchmaking service that keeps waiting players in a Redis sorted set per
  time control and pairs them atomically with a Lua script, widening the rating
  window the longer a player waits.
- A gateway that holds the matchmaking request as a long-poll until the
  matchmaker publishes a pairing, then hands the client their game id and
  colour.
- A game server (planned) that owns live games in memory, validates every move,
  runs the two clocks, and persists each move before broadcasting it to the
  other side.
- A session router (planned) that pins both players of a game to the same game
  server using a consistent-hash ring over an etcd membership registry, so a
  server crash can be recovered by a replacement that replays the move log.
- A leaderboard (planned) that applies the ELO delta on game end, idempotent on
  the game id, and serves top-N and own-rank reads from a Redis sorted set
  mirrored by Postgres.
- Shared packages for the chess rules (a wrapper over chess.js), the Drizzle
  schema and repositories, the wire contracts (zod schemas used on both ends),
  the typed config loader, a Pino logger with health/metrics routes, and a
  Redis client factory with a tiny Lua-script helper.

## Repo layout

```
chess/
├── apps/
│   ├── gateway/          REST edge: matchmaking long-poll, game reads
│   ├── matchmaker/       pairing worker (Redis pool + Lua claim + sweeper)
│   ├── session-router/   consistent-hash routing (planned)
│   ├── game-server/      live games over WebSocket (planned)
│   └── leaderboard/      ELO apply + rank reads (planned)
├── packages/
│   ├── chess-engine/     rules wrapper over chess.js
│   ├── domain/           pure types + ELO + time-control parsing
│   ├── db/               Drizzle schema, migrations, repositories, seed
│   ├── redis/            ioredis factory + Lua-script helper
│   ├── protocol/         zod request/response + WS message schemas
│   ├── config/           typed env loader
│   └── telemetry/        logger + /healthz /readyz /metrics
├── infra/compose/        docker-compose for Postgres, Redis, etcd
└── docs/                 longer design notes (links below)
```

## Running it locally

The whole stack runs on Docker + Node 22 + pnpm. Each service is wired through
`@chess/config` and reads defaults from env, so the laptop setup needs no
configuration beyond starting the compose stack.

```bash
pnpm install
pnpm stack:up                                       # Postgres + Redis + etcd
pnpm --filter @chess/db exec drizzle-kit migrate    # apply the schema
SEED_COUNT=20 pnpm --filter @chess/db db:seed       # a few seed players

# two terminals:
pnpm --filter @chess/matchmaker dev                 # :3001
pnpm --filter @chess/gateway dev                    # :3000
```

Health checks: `curl localhost:3000/healthz` and `localhost:3001/healthz`.

A full matchmaking round-trip, two players at once:

```bash
curl -s -X POST http://localhost:3000/matchmaking \
  -H 'content-type: application/json' -H 'x-player-id: <uuid-a>' \
  -d '{"timeControl":"blitz-3-2"}' &
curl -s -X POST http://localhost:3000/matchmaking \
  -H 'content-type: application/json' -H 'x-player-id: <uuid-b>' \
  -d '{"timeControl":"blitz-3-2"}' &
wait
```

Both responses carry the same `gameId`, mirrored colours, and the other
player's details. Fetch the game row with `GET /games/<gameId>`.

## Scripts

- `pnpm dev` — bring up the compose stack and run every app under `tsx watch`.
- `pnpm build` — bundle each service with tsup.
- `pnpm test` — Vitest across every package. Some tests spin up Postgres or
  Redis via Testcontainers, so Docker needs to be running.
- `pnpm lint` / `pnpm typecheck` — ESLint + `tsc --noEmit` over the whole
  workspace.
- `pnpm --filter @chess/matchmaker smoke` — manual smoke script that fires N
  concurrent claims against a live Redis and verifies the pairing invariants.

## Design notes

Longer-form docs live under `docs/`. They're the planning side of the repo and
go into more depth than the code comments.

- [00-requirements.md](docs/00-requirements.md) — what the system needs to do
  and how much of it.
- [01-hld.md](docs/01-hld.md) — the services and how they talk to each other.
- [02-lld.md](docs/02-lld.md) — schema, API shapes, the matchmaking claim, the
  game-server fencing token, latency compensation, leaderboard rank reads.
- [03-tech-stack.md](docs/03-tech-stack.md) — the technology choices with the
  alternative that was rejected for each.
- [04-project-plan.md](docs/04-project-plan.md) — the build order, feature by
  feature, with the test that proves each piece is done.
- [05-observability.md](docs/05-observability.md) — logs, metrics, traces,
  dashboards.
- [06-deployment.md](docs/06-deployment.md) — packaging and the deploy target.

## Status

The chess rules, the Postgres layer with the generation-fenced move write, the
ELO math, matchmaking end-to-end (pool, atomic claim, widening-window sweeper,
long-poll, game creation), and the gateway's `POST /matchmaking` + `GET
/games/:id` are all in and tested. The game server, the session router, the
leaderboard, and the observability pass are next.
