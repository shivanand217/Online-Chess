# Deploying to Fly.io

Seven Fly apps. Six here in `Chess/` (five services + a single-node etcd), one in `../chess-web`.
All on Fly's shared-cpu-1x tier, in one region, scale-to-zero where safe.

```
chess-gateway        public HTTPS         3000   fans out to the four internal apps
chess-matchmaker     internal only        3001   pairing worker (one machine, always on)
chess-session-router internal only        3002   consistent-hash ring over etcd
chess-game-server    public (WebSocket)   3003   live games
chess-leaderboard    internal only        3004   ELO apply + top-N
chess-etcd           internal only        2379   service registry
chess-web            public HTTPS         3000   Next.js frontend
```

## 0. Prerequisites

- A Fly account + `flyctl` installed (`brew install flyctl` on macOS).
- `fly auth login` done.
- Docker running locally — the frontend is `fly deploy --local-only` because it needs the sibling
  Chess repo on disk at build time.

## 1. Managed Postgres + Redis

```bash
# Postgres (shared across all five services via DATABASE_URL).
fly postgres create --name chess-postgres --region iad \
  --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10

# Redis via Fly's Upstash extension (asks you to pick a plan).
fly redis create --name chess-redis --region iad
```

`fly postgres create` prints the `postgres://` URL; `fly redis create` prints a `rediss://` URL.
Save both — you'll feed them to every service via `fly secrets set`.

## 2. etcd (service registry)

Single-node etcd. If the machine dies you lose membership state; the game-server + session-router
re-register on boot so a crash recovery is a short bounce, not a cluster rebuild. For production
you'd want a 3-node cluster.

```bash
cd ~/Documents/bck-works/Chess
fly launch --no-deploy --copy-config --config infra/fly/etcd/fly.toml --name chess-etcd
fly volumes create etcd_data --app chess-etcd --region iad --size 1
fly deploy --config infra/fly/etcd/fly.toml
```

## 3. Deploy the five services

Run each from the Chess repo root so the Dockerfile build context contains the whole monorepo:

```bash
cd ~/Documents/bck-works/Chess

# Create the apps (one-time; the fly.toml holds the right name).
for svc in gateway matchmaker session-router game-server leaderboard; do
  fly apps create "chess-$svc"
done

# Common secrets. Replace the JWT_SECRET with a real 32+ char value.
JWT_SECRET="$(openssl rand -hex 32)"
for svc in gateway matchmaker session-router game-server leaderboard; do
  fly secrets set --app "chess-$svc" \
    DATABASE_URL="<postgres url from step 1>" \
    REDIS_URL="<redis url from step 1>" \
    JWT_SECRET="$JWT_SECRET"
done

# Gateway also needs the allowed browser origin so CORS lets chess-web.fly.dev in.
fly secrets set --app chess-gateway CORS_ORIGINS="https://chess-web.fly.dev"

# Deploy. Order matters only loosely — the gateway reads its downstream URLs from env, so if the
# downstreams aren't up yet it returns 502s until they are. Fly's health checks will mark them
# ready as they come online.
for svc in matchmaker session-router leaderboard game-server gateway; do
  fly deploy --config "apps/$svc/fly.toml" --dockerfile "apps/$svc/Dockerfile"
done
```

## 4. Database migrations + seed

Migrations run against the managed Postgres from your laptop (one shot, not inside Fly):

```bash
# Open a proxied connection to Fly's Postgres on localhost:5433.
fly proxy 5433:5432 --app chess-postgres &
export DATABASE_URL="postgres://postgres:<password>@localhost:5433/postgres"
pnpm --filter @chess/db exec drizzle-kit migrate
SEED_COUNT=20 pnpm --filter @chess/db db:seed    # optional — gives you player_000000..19
kill %1
```

## 5. Frontend

The frontend's Dockerfile expects both repos on disk, so build locally and push the image:

```bash
cd ~/Documents/bck-works
fly launch --no-deploy --copy-config --config chess-web/fly.toml --name chess-web
fly deploy --local-only \
  --config chess-web/fly.toml \
  --dockerfile chess-web/Dockerfile
```

If the gateway app ends up on a different hostname than `chess-gateway.fly.dev`, update
`NEXT_PUBLIC_GATEWAY_URL` in `chess-web/fly.toml` before this step (and the gateway's
`CORS_ORIGINS` to match).

## 6. Verify

```bash
curl -i https://chess-gateway.fly.dev/healthz
open https://chess-web.fly.dev
```

Sign in with a seeded account (`player_000000` / `pw_player_000000`) or create one. Open a second
browser (incognito) and matchmake with another seeded user. The browser WS should connect to
`wss://chess-game-server.fly.dev/ws/games/<id>`.

## Known limitations

- **One game-server instance.** The session router's consistent-hash ring supports multiple, but
  per-machine addressing on Fly needs the Fly-Replay header to shard WS traffic. Single-instance
  is enough for a demo.
- **Single-node etcd.** Already called out above.
- **No CDN in front of the frontend.** Static assets are served by the Next server; add Fly's
  edge cache or front with Cloudflare if traffic warrants.
- **No autoscaling policy for game-server.** `min_machines_running = 1`, no upper bound. Add
  `fly scale count` as you need.
