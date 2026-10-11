#!/usr/bin/env bash
# Boot the full dev stack from a cold machine: compose infra, backend services, frontend.
# Idempotent — safe to re-run; already-up services are left alone.
#
#   usage:  ./tools/boot-stack.sh         # core infra + backend + frontend
#           STOP=1 ./tools/boot-stack.sh  # tear everything down instead
#           SKIP_WEB=1 ./tools/boot-stack.sh   # backend only
#           OBS=1 ./tools/boot-stack.sh   # also bring up Prometheus/Grafana/Tempo

set -euo pipefail

# Resolve the Chess repo root from the script's own location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHESS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$(cd "$CHESS_DIR/../chess-web" 2>/dev/null && pwd || true)"
LOGS="/tmp/chess-logs"
mkdir -p "$LOGS"

BACKEND_SERVICES=(matchmaker session-router game-server gateway leaderboard)
PORTS=(3000 3001 3002 3003 3004)
FRONTEND_PORT=4000

say() { printf '  %s\n' "$*"; }
hr() { printf '─── %s ─────────────────────────────────\n' "$*"; }

kill_port() {
  local port="$1"
  local pid
  pid="$(lsof -ti ":$port" 2>/dev/null | head -1 || true)"
  if [[ -n "$pid" ]]; then
    kill -9 "$pid" 2>/dev/null || true
    say "killed pid $pid on :$port"
  fi
}

if [[ "${STOP:-0}" = "1" ]]; then
  hr "stopping everything"
  for p in "${PORTS[@]}" "$FRONTEND_PORT"; do kill_port "$p"; done
  (cd "$CHESS_DIR" && pnpm stack:down)
  say "done"
  exit 0
fi

hr "sweeping stale processes"
for p in "${PORTS[@]}" "$FRONTEND_PORT"; do kill_port "$p"; done

hr "compose stack"
cd "$CHESS_DIR"
if [[ "${OBS:-0}" = "1" ]]; then
  pnpm stack:up:obs > /dev/null
  say "core + observability up"
else
  pnpm stack:up > /dev/null
  say "core up (postgres, redis, etcd)"
fi

# Wait for Postgres to accept connections before we try migrations/seed.
hr "waiting for postgres"
for i in {1..30}; do
  if docker exec chess-postgres-1 pg_isready -U chess -d chess >/dev/null 2>&1; then
    say "postgres ready (after ${i}s)"
    break
  fi
  sleep 1
done

hr "schema + seed (idempotent)"
# drizzle-kit migrate is a no-op if everything is applied.
pnpm --filter @chess/db exec drizzle-kit migrate 2>&1 | tail -1 | sed 's/^/  /'
# Seed only if the players table is empty, so we don't bloat the DB on every boot.
PLAYER_COUNT="$(docker exec chess-postgres-1 psql -U chess -d chess -t -A -c 'SELECT count(*) FROM players' 2>/dev/null || echo 0)"
if [[ "$PLAYER_COUNT" -eq 0 ]]; then
  say "players table empty — seeding 20"
  SEED_COUNT=20 pnpm --filter @chess/db db:seed 2>&1 | tail -1 | sed 's/^/  /'
else
  say "players table already has $PLAYER_COUNT rows — skipping seed"
fi

hr "backend services"
for svc in "${BACKEND_SERVICES[@]}"; do
  (cd "$CHESS_DIR" && pnpm --filter "@chess/$svc" exec tsx --import ./src/tracing.ts src/index.ts) \
    > "$LOGS/$svc.log" 2>&1 &
  say "$svc pid=$!   log → $LOGS/$svc.log"
done

if [[ "${SKIP_WEB:-0}" != "1" && -d "$WEB_DIR" ]]; then
  hr "frontend"
  (cd "$WEB_DIR" && ./node_modules/.bin/next dev -p "$FRONTEND_PORT") \
    > "$LOGS/web.log" 2>&1 &
  say "web pid=$!   log → $LOGS/web.log"
elif [[ "${SKIP_WEB:-0}" = "1" ]]; then
  say "SKIP_WEB=1 — frontend not started"
else
  say "chess-web not found at $CHESS_DIR/../chess-web — frontend not started"
fi

hr "waiting for everyone to listen"
sleep 6

hr "health"
for i in "${!PORTS[@]}"; do
  svc="${BACKEND_SERVICES[$i]}"
  port="${PORTS[$i]}"
  code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$port/healthz" 2>/dev/null || true)"
  if [[ -n "$code" ]]; then say "$svc  :$port  $code"; else say "$svc  :$port  DOWN"; fi
done
if [[ "${SKIP_WEB:-0}" != "1" && -d "$WEB_DIR" ]]; then
  code="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$FRONTEND_PORT/" 2>/dev/null || true)"
  if [[ -n "$code" ]]; then say "web  :$FRONTEND_PORT  $code"; else say "web  :$FRONTEND_PORT  DOWN (still compiling? tail $LOGS/web.log)"; fi
fi

echo ""
echo "  logs:    $LOGS/<service>.log  (tail -f to watch)"
echo "  stop:    STOP=1 $CHESS_DIR/tools/boot-stack.sh"
echo "  frontend http://localhost:$FRONTEND_PORT"
