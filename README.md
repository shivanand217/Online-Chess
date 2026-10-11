# Chess

Real-time online chess, written to see how far I could push a server-authoritative
design on a laptop: matchmaking, live games over WebSockets, flagging on time,
ratings, the lot. TypeScript throughout. The browser UI lives next to this repo
at `../chess-web`.

## What's in here

- **Gateway** (`:3000`) — the only service a client talks to. Mints JWTs
  (`/auth/signup`, `/auth/token`), holds the matchmaking long-poll
  (`POST /matchmaking`), serves `GET /games/:id`, proxies the leaderboard,
  and hands back the game-server WS URL from the router.
- **Matchmaker** (`:3001`) — Redis sorted set per time control. Pairing is a
  Lua script so no two workers can book the same opponent. A background sweep
  widens the rating window as a lonely player waits.
- **Session router** (`:3002`) — consistent-hash ring over an etcd membership
  registry. Both players of a game end up on the same game-server.
- **Game server** (`:3003`) — stateful WebSocket. Owns the authoritative
  board + both clocks. Verifies the JWT on every upgrade. Persists each move
  before broadcasting it, so a crash never loses one. Flags on time. Credits
  the mover up to 100ms per move for RTT.
- **Leaderboard** (`:3004`) — idempotent ELO apply on game end, keyed by
  `gameId` so a replay is a no-op. Top-N via a Redis sorted set, with a
  reconciliation path that rebuilds from Postgres truth.

Plus the packages: chess rules (wraps chess.js), Drizzle schema +
migrations + repositories, zod wire contracts, a typed config loader,
Pino logs + Prometheus `/metrics` + OTel traces, the etcd registry wrapper,
and the SDK (`@chess/client`) `../chess-web` depends on.

## Layout

```
apps/
├── gateway/          REST edge, auth, long-poll
├── matchmaker/       pairing worker (Redis pool + Lua claim + sweeper)
├── session-router/   consistent-hash ring over etcd
├── game-server/      live games over WebSocket
└── leaderboard/      ELO apply + rank reads
packages/
├── chess-engine/     rules wrapper over chess.js
├── domain/           pure types + ELO + time-control parsing
├── db/               Drizzle schema, migrations, repositories, seed, bcrypt
├── redis/            ioredis factory + Lua-script helper
├── registry/         etcd3 wrapper (register-with-lease + watch)
├── protocol/         zod request/response + WS message schemas
├── config/           typed env loader
├── telemetry/        logger + /healthz /readyz /metrics + OTel bootstrap
└── client/           browser + Node SDK (http + typed GameSession)
infra/compose/        docker-compose for Postgres, Redis, etcd + obs profile
tools/boot-stack.sh   one-command dev bring-up
docs/                 design notes
```

## Running

### The short version

```bash
~/Documents/bck-works/Chess/tools/boot-stack.sh
```

Starts compose (Postgres, Redis, etcd), runs migrations, seeds 20 players if
the table is empty, boots all five backend services under `tsx watch` with
OTel preloaded, boots the frontend from `../chess-web`, and prints a health
probe for every port.

Variants:

```bash
STOP=1      ...boot-stack.sh    # tear everything down
SKIP_WEB=1  ...boot-stack.sh    # backend only
OBS=1       ...boot-stack.sh    # also Prometheus / Grafana / Tempo
```

Service logs land in `/tmp/chess-logs/<svc>.log`. `tail -f` any of them.

I keep two aliases in `~/.zshrc`:

```bash
alias chess-up='~/Documents/bck-works/Chess/tools/boot-stack.sh'
alias chess-down='STOP=1 ~/Documents/bck-works/Chess/tools/boot-stack.sh'
```

### Prerequisites

Node 22 LTS (`brew install node@22`), pnpm via `corepack enable`, Docker Desktop.

### The long version (by hand)

If you'd rather drive each piece yourself:

```bash
cd ~/Documents/bck-works/Chess
pnpm install
pnpm stack:up                                        # Postgres + Redis + etcd
pnpm --filter @chess/db exec drizzle-kit migrate
SEED_COUNT=20 pnpm --filter @chess/db db:seed
```

Then one terminal per service:

```bash
pnpm --filter @chess/matchmaker dev            # :3001
pnpm --filter @chess/session-router dev        # :3002
pnpm --filter @chess/game-server dev           # :3003
pnpm --filter @chess/gateway dev               # :3000
pnpm --filter @chess/leaderboard dev           # :3004  (optional for play)
```

And the frontend from `../chess-web`:

```bash
cd ~/Documents/bck-works/chess-web
pnpm install
pnpm dev                                       # :4000
```

### Signing in

The seed creates `player_000000` through `player_000019`. The password is
literally `pw_` + the username, i.e. `pw_player_000000`. Or click "Create one"
on the login page and pick anything.

Open two browser windows (one incognito so the sessions don't share
localStorage), sign in as different seeded players, both click "Find a
match". Both windows land on `/game/<same-uuid>` within a second.

### Health probe

```bash
for port in 3000 3001 3002 3003 3004 4000; do
  path=/healthz; [ "$port" = 4000 ] && path=/
  curl -sf -o /dev/null -w "  :$port  %{http_code}\n" --max-time 1 \
    "http://localhost:$port$path" || echo "  :$port  DOWN"
done
```

### Stopping

```bash
STOP=1 ~/Documents/bck-works/Chess/tools/boot-stack.sh
```

Or the manual version:

```bash
for port in 3000 3001 3002 3003 3004 4000; do
  pid=$(lsof -ti :$port 2>/dev/null) && [ -n "$pid" ] && kill -9 $pid
done
pnpm stack:down
```

### When it won't come up

- **`ERR_PNPM_IGNORED_BUILDS: unrs-resolver`** — pnpm 11 asks you to approve
  build scripts. Both repos pin the allowlist in `pnpm-workspace.yaml`. If
  pnpm rewrote the file with a placeholder, overwrite with:
  ```yaml
  onlyBuiltDependencies:
    - unrs-resolver
  ```
- **`net::ERR_CONNECTION_REFUSED` in the browser** — the gateway isn't up.
  `curl localhost:3000/healthz`.
- **CORS "Failed to fetch"** — the browser's origin isn't in `CORS_ORIGINS`.
  The dev default allows `http://localhost:4000`.
- **`password_hash column does not exist`** — migrations haven't run against
  the DB. `pnpm --filter @chess/db exec drizzle-kit migrate`.
- **Both players matching with themselves** — Next.js Strict Mode double-fires
  dev effects. Already fixed in `../chess-web/src/lib/matchmaking-store.ts`
  via module-level dedupe. Pull if you've forked an older state.

## Observability

Bring up the obs profile with `OBS=1 ...boot-stack.sh` (or `pnpm stack:up:obs`).
Prometheus runs on `:9090`, Grafana on `:3100` (anonymous admin), Tempo
query on `:3200` + OTLP on `:4317` (gRPC) and `:4318` (HTTP). Three
dashboards auto-provision under a Chess folder: Services Overview, Matchmaking,
Game Server. Every service exports Prometheus metrics on `/metrics` and
sends OTel spans to Tempo (correlated with the request's `trace_id` stamped
into every Pino log line).

## Scripts

- `pnpm stack:up` / `pnpm stack:up:obs` / `pnpm stack:down`
- `pnpm build` — tsup bundle every service to `dist/`.
- `pnpm test` — Vitest across every package. Some tests spin up Postgres /
  Redis / etcd via Testcontainers; Docker needs to be running.
- `pnpm lint` / `pnpm typecheck` — ESLint + `tsc --noEmit` over the workspace.
- `pnpm docker:build` — build a container image for each service as
  `chess/<svc>:dev`.
- `pnpm --filter @chess/matchmaker smoke` — fires N concurrent Lua claims
  against a live Redis and verifies the pairing invariants hold.
- `pnpm --filter @chess/db db:seed` — insert `SEED_COUNT` players (default
  10 000).

## Design notes

Longer-form stuff lives under `docs/`. The code comments are terse because
the real explanations are there.

- [00-requirements.md](docs/00-requirements.md) — what the system has to do
  and how much of it.
- [01-hld.md](docs/01-hld.md) — services and how they talk.
- [02-lld.md](docs/02-lld.md) — schema, API shapes, the matchmaking claim,
  the fencing token, latency compensation, leaderboard rank reads.
- [03-tech-stack.md](docs/03-tech-stack.md) — technology choices and the
  alternatives I rejected.
- [04-project-plan.md](docs/04-project-plan.md) — the build order.
- [05-observability.md](docs/05-observability.md) — logs, metrics, traces.
- [06-deployment.md](docs/06-deployment.md) — packaging + deploy target.

## Status

In and tested end-to-end: the chess rules, Postgres with generation-fenced
move writes, the ELO math, matchmaking (pool, atomic claim, widening-window
sweeper, long-poll, game creation), JWT auth with bcrypt'd passwords and
same-code 401s to kill the enumeration oracle, CORS, per-IP rate limiting on
`/auth/token` + `/auth/signup`, WebSocket gameplay with persist-before-broadcast,
flag timer, resign, reconnect-via-replay, JWT verification on upgrade (header
or `?token=`), RTT compensation, consistent-hash routing over etcd,
idempotent ELO apply with a reconciliation rebuild, structured logs +
Prometheus metrics + OTel distributed traces, Grafana dashboards, Dockerfiles
per service, and the SDK the frontend consumes.

Playable against `../chess-web`: login + signup, matchmaking, live board,
check indicator, win/lose/draw banner, promotion dialog, move list,
leaderboard.

Still on the list:

- The server-side matchmaker doesn't dedupe by `playerId` yet. The frontend
  prevents the common case, but a bad client could still enqueue twice and
  self-pair. Trivial Redis slot-key fix.
- No WS auto-reconnect on the frontend. A dropped socket shows red; refresh
  reconnects via `GET /games/:id`.
- No load / chaos drill. Would want a k6-style driver pushing real traffic
  through the whole stack to see the Grafana dashboards fill in.
