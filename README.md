# Chess

A real-time online chess platform I'm building in TypeScript. Players sign in,
get matched against someone of a similar rating, play a timed game over a
WebSocket, and show up on a global leaderboard afterwards. The repo is a pnpm
monorepo with five small services, a shared chess engine, a Postgres schema,
and Redis for the parts that need fast shared state. The browser-facing UI
lives in a sibling repo at `../chess-web`.

## What's in here

- **Gateway** — REST edge for the client. Mints JWTs (`/auth/signup`,
  `/auth/token`), holds the matchmaking long-poll (`POST /matchmaking`),
  serves `GET /games/:id`, and surfaces the game-server WS URL from the
  session router.
- **Matchmaker** — keeps waiting players in a Redis sorted set per time
  control and pairs them atomically with a Lua script, widening the rating
  window the longer a player waits. On a successful pair, writes the Game row
  and publishes on `match:<requestId>`.
- **Session router** — consistent-hash ring over an etcd membership registry
  that pins both players of a game to the same game-server instance.
- **Game server** — stateful, in-memory gameplay over WebSockets. Owns the
  authoritative board + both clocks. Verifies a JWT on every upgrade,
  persists each move before broadcasting it, flags on timer expiry, applies
  RTT compensation (±100 ms cap) to the mover.
- **Leaderboard** — idempotent ELO apply on game end (keyed by `gameId`), plus
  top-N and own-rank reads from a Redis sorted set mirrored by Postgres.
- **Shared packages**: the chess rules (wraps chess.js), the Drizzle schema +
  migrations + repositories, the wire contracts (zod schemas used on both
  ends), a typed config loader, a Pino logger with health / readyz / Prometheus
  `/metrics`, a Redis client factory with a Lua-script helper, an etcd
  registry wrapper, OpenTelemetry traces (OTLP → Tempo), and the typed SDK
  (`@chess/client`) the frontend consumes.

## Repo layout

```
chess/
├── apps/
│   ├── gateway/          REST edge, auth, long-poll
│   ├── matchmaker/       pairing worker (Redis pool + Lua claim + sweeper)
│   ├── session-router/   consistent-hash ring over etcd
│   ├── game-server/      live games over WebSocket
│   └── leaderboard/      ELO apply + rank reads
├── packages/
│   ├── chess-engine/     rules wrapper over chess.js
│   ├── domain/           pure types + ELO + time-control parsing
│   ├── db/               Drizzle schema, migrations, repositories, seed, bcrypt
│   ├── redis/            ioredis factory + Lua-script helper
│   ├── registry/         etcd3 wrapper (register-with-lease + watch)
│   ├── protocol/         zod request/response + WS message schemas
│   ├── config/           typed env loader
│   ├── telemetry/        logger + /healthz /readyz /metrics + OTel bootstrap
│   └── client/           browser + Node SDK (http + typed GameSession)
├── infra/compose/        docker-compose for Postgres, Redis, etcd + obs profile
├── docs/                 longer design notes
└── ../chess-web/         Next.js frontend (sibling repo)
```

## Running from scratch

### Prerequisites

| Tool   | Version     | How I install it on macOS                    |
| ------ | ----------- | -------------------------------------------- |
| Node   | ≥ 22 LTS    | `brew install node@22` + `brew link node@22` |
| pnpm   | 10+         | `corepack enable` (ships with Node)          |
| Docker | Desktop 4.x | https://docs.docker.com/desktop/             |

Verify:

```bash
node -v    # v22.x
pnpm -v    # 10.x or 11.x
docker ps  # should not error
```

### First-time setup

```bash
cd ~/Documents/bck-works/Chess

# 1. Install workspace deps (one-time; also runs after a pull that touches deps)
pnpm install

# 2. Bring up the infra containers (Postgres + Redis + etcd)
pnpm stack:up                                        # core only
# or with observability (Prometheus + Grafana + Tempo):
# pnpm stack:up:obs

# 3. Apply the schema (idempotent — safe to re-run)
pnpm --filter @chess/db exec drizzle-kit migrate

# 4. Seed 20 players with hashed passwords
SEED_COUNT=20 pnpm --filter @chess/db db:seed
# → each `player_000NNN` logs in with password `pw_player_000NNN`
```

### Start all five services

Each service runs under `tsx watch` with OTel preloaded via `--import ./src/tracing.ts`.
Open five terminals, or run them in the background (see the one-shot block
below).

```bash
# Terminal 1 — matchmaker (:3001)
pnpm --filter @chess/matchmaker dev

# Terminal 2 — session-router (:3002)
pnpm --filter @chess/session-router dev

# Terminal 3 — game-server (:3003)
pnpm --filter @chess/game-server dev

# Terminal 4 — gateway (:3000)      ← depends on matchmaker + session-router
pnpm --filter @chess/gateway dev

# Terminal 5 — leaderboard (:3004)   ← optional for play
pnpm --filter @chess/leaderboard dev
```

### One-shot background boot

```bash
cd ~/Documents/bck-works/Chess
pnpm stack:up

LOGS=/tmp/chess-logs && mkdir -p "$LOGS"
for svc in matchmaker session-router game-server gateway leaderboard; do
  pnpm --filter @chess/$svc exec tsx --import ./src/tracing.ts src/index.ts \
    > "$LOGS/$svc.log" 2>&1 &
  echo "$svc pid=$!"
done

sleep 6
for pair in gateway:3000 matchmaker:3001 session-router:3002 \
            game-server:3003 leaderboard:3004; do
  svc=${pair%:*}; port=${pair#*:}
  curl -sf -o /dev/null -w "  $svc  :$port  %{http_code}\n" \
    --max-time 2 "http://localhost:$port/healthz" || echo "  $svc  :$port  DOWN"
done
```

Tail any service's log:

```bash
tail -f /tmp/chess-logs/gateway.log
```

### Frontend (sibling repo)

```bash
cd ~/Documents/bck-works/chess-web
pnpm install                     # one-time
cp .env.example .env.local       # points at http://localhost:3000
pnpm dev                         # :4000
```

Open **http://localhost:4000**, log in with one of the seeded accounts:

- Username: `player_000000` → `player_000019`
- Password: `pw_<username>` (so `pw_player_000000`)

Open a second window / incognito, log in as a different seeded player, and
both click **Find a match**. Both land on `/game/<same-uuid>` within a second.

### Health audit — any time

```bash
for pair in gateway:3000 matchmaker:3001 session-router:3002 \
            game-server:3003 leaderboard:3004 web:4000; do
  svc=${pair%:*}; port=${pair#*:}
  path=/healthz; [ "$port" = 4000 ] && path=/
  code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 1 \
    "http://localhost:$port$path") && echo "  $svc  :$port  $code" || echo "  $svc  :$port  DOWN"
done
docker ps --format '  {{.Names}}  {{.Status}}' | grep chess
```

### Stop everything

```bash
# 1. Kill all five services + frontend
for port in 3000 3001 3002 3003 3004 4000; do
  pid=$(lsof -ti :$port 2>/dev/null)
  [ -n "$pid" ] && kill -9 $pid && echo ":$port killed"
done

# 2. Compose stack (also tears down any observability containers)
cd ~/Documents/bck-works/Chess
pnpm stack:down
```

### Restart a single service

`tsx watch` already auto-reloads on code changes — most of the time you don't
need to restart anything. If you have to:

```bash
# kill the one service
kill -9 $(lsof -ti :3000)                                 # gateway

# relaunch
cd ~/Documents/bck-works/Chess
pnpm --filter @chess/gateway dev
```

### Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS: unrs-resolver`** — pnpm 11 asks you to approve
  build scripts. Both repos already pin the allowlist in `pnpm-workspace.yaml`;
  if the file gets rewritten with a placeholder, overwrite it to:
  ```yaml
  onlyBuiltDependencies:
    - unrs-resolver
  ```
- **`net::ERR_CONNECTION_REFUSED` in the browser** — the gateway isn't up.
  Check `curl localhost:3000/healthz`.
- **CORS "Failed to fetch"** — the browser's origin isn't in `CORS_ORIGINS`.
  Dev defaults to `http://localhost:4000`; override via env if you run the
  frontend somewhere else.
- **`password_hash column does not exist`** — migrations haven't run against
  the DB. Run `pnpm --filter @chess/db exec drizzle-kit migrate`.
- **Both players matching with themselves** — Next.js Strict Mode double-fires
  dev effects. Already fixed in `chess-web/src/lib/matchmaking-store.ts` via
  module-level dedupe; make sure your frontend is on `main`.

## Observability

With `pnpm stack:up:obs`, Prometheus (`:9090`), Grafana (`:3100`, anonymous
admin), and Tempo (`:3200` query / `:4317` OTLP gRPC / `:4318` OTLP HTTP)
come up. Each service's `--import ./src/tracing.ts` sends spans to Tempo and
exposes Prometheus metrics on `/metrics`. Three Grafana dashboards are
auto-provisioned under the **Chess** folder: Services Overview, Matchmaking,
Game Server.

## Scripts (root)

- `pnpm stack:up` / `pnpm stack:up:obs` / `pnpm stack:down`
- `pnpm build` — tsup bundle every service to `dist/`.
- `pnpm test` — Vitest across every package. Some tests spin up Postgres /
  Redis / etcd via Testcontainers, so Docker needs to be running.
- `pnpm lint` / `pnpm typecheck` — ESLint + `tsc --noEmit` over the workspace.
- `pnpm docker:build` — build a container image for each service as
  `chess/<svc>:dev`.
- `pnpm --filter @chess/matchmaker smoke` — fires N concurrent Lua claims
  against a live Redis and verifies the pairing invariants hold.
- `pnpm --filter @chess/db db:seed` — insert N seed players (controlled by
  `SEED_COUNT` env, default 10 000).

## Design notes

Longer-form docs live under `docs/`. They're the planning side of the repo
and go into more depth than the code comments.

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

**In and tested end-to-end:**

- Chess rules engine (perft at depth 4 passes).
- Postgres layer with generation-fenced move writes.
- ELO math + time-control parsing.
- Matchmaking: Redis sorted-set pool, atomic Lua claim (race-free under
  concurrency tests), widening-window sweeper, long-poll with cancel, game
  creation on pair.
- Gateway: JWT auth (bcrypt-hashed passwords, 401 on wrong creds or unknown
  user — same code to prevent enumeration), CORS, `POST /auth/signup`,
  `POST /auth/token`, held `POST /matchmaking`, `GET /games/:id`.
- Game server: WebSocket gameplay with persist-before-broadcast,
  server-authoritative clocks, flag timer, resign, reconnect-via-replay, JWT
  verification on upgrade (header or `?token=`), RTT compensation.
- Session router: consistent-hash ring over an etcd membership registry.
- Leaderboard: idempotent ELO apply (keyed by `gameId`), sweeper over
  finished-but-unapplied games, `GET /leaderboard` + `GET /players/:id/rank`,
  reconciliation (rebuild Redis from Postgres truth).
- Observability: Pino structured logs with request-id correlation, Prometheus
  RED + domain metrics, OTel distributed traces across all services, three
  Grafana dashboards, recording + alerting rules.
- Typed SDK (`@chess/client`) consumed by the frontend (`chess-web`).
- Dockerfiles per service, `pnpm docker:build` convenience script.

**Playable** against the sibling `chess-web` frontend: username+password
login, matchmaking long-poll, live game with react-chessboard, in-check
indicator, win/lose/draw banner on game end.

**Known gaps** worth naming:

- No rate limiting on `/auth/token` (brute-force window still open).
- Server-side matchmaker doesn't dedupe by `playerId` — frontend dedupe
  prevents the common case but a malicious client could still enqueue twice.
- No promotion dialog in the UI (auto-promotes to queen).
- No move-list panel on the game page (store has the data).
- No auto-reconnect on the WS (page shows a red error on drop).
