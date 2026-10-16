# Deploying to Google Cloud

Everything backend-side runs on Cloud Run; data lives in Cloud SQL + Memorystore; etcd runs on a
single e2-micro Compute Engine VM (free-tier eligible). The frontend is also Cloud Run so there's
one deploy tool for everything.

## Architecture

```
                           ┌────────────────────────────────┐
             Browser  ──►  │  chess-web (Cloud Run, public) │
                           └────────────┬───────────────────┘
                                        │  HTTPS
                                        ▼
                           ┌────────────────────────────────┐
                           │  chess-gateway (Cloud Run)     │  ◄── WebSocket
                           │  public HTTPS, mints JWTs      │     to game-server
                           └──┬──────┬────────┬────────┬────┘
                              │      │        │        │                         ┌──────────────┐
                              ▼      ▼        ▼        ▼                         │   Browser    │
                        ┌─────────┐ ┌────────┐ ┌─────────┐ ┌──────────┐          │              │
                        │ match-  │ │session-│ │leader-  │ │ game-    │ ◄── wss ─┤  (bypasses   │
                        │ maker   │ │router  │ │board    │ │ server   │          │   gateway)   │
                        └────┬────┘ └───┬────┘ └────┬────┘ └───┬──────┘          └──────────────┘
                             │          │           │          │
                             ▼          ▼           ▼          ▼
                   ┌───────────────────────────────────────────────────┐
         Private   │       Serverless VPC Access connector             │
         6PN       │                                                   │
                   └──┬─────────────────────┬──────────────────┬────────┘
                      ▼                     ▼                  ▼
               ┌─────────────┐       ┌───────────────┐    ┌──────────┐
               │ Cloud SQL   │       │ Memorystore   │    │ GCE VM   │
               │ (Postgres)  │       │ (Redis)       │    │ (etcd)   │
               └─────────────┘       └───────────────┘    └──────────┘
```

## Service mapping

| Component            | GCP service                   | Notes                                                 |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| chess-gateway        | Cloud Run (public)            | HTTPS edge, min=0 scale-to-zero                       |
| chess-matchmaker     | Cloud Run (internal)          | min=1 so the sweep timer stays alive                  |
| chess-session-router | Cloud Run (internal)          | min=1, watches etcd for membership                    |
| chess-game-server    | Cloud Run (public, WebSocket) | min=max=1 for now (single-instance; see Known Issues) |
| chess-leaderboard    | Cloud Run (internal)          | min=1                                                 |
| chess-web            | Cloud Run (public)            | Next 15 standalone bundle, min=0                      |
| Postgres             | Cloud SQL for PostgreSQL      | db-f1-micro, 10GB SSD, daily backups                  |
| Redis                | Memorystore for Redis         | Basic tier 1GB, single-AZ                             |
| etcd                 | Compute Engine (e2-micro)     | 1 node, 10GB disk; free-tier eligible in us-west1     |
| Container images     | Artifact Registry             | Docker format, one repo for all services              |
| CI image builds      | Cloud Build                   | Triggered by `gcloud run deploy --source .`           |
| Secrets              | Secret Manager                | JWT_SECRET, DB password, Redis AUTH                   |
| Private networking   | VPC + Serverless VPC Access   | Cloud Run → Memorystore/etcd                          |
| Logs + traces        | Cloud Logging + Cloud Trace   | OTel SDK writes here natively via GCP auto-detect     |

## 0. Prerequisites

- A GCP account with billing enabled. New accounts get $300 of free credits for 90 days which
  covers everything here many times over.
- `gcloud` CLI installed and logged in: `brew install --cask google-cloud-sdk && gcloud auth login`.
- Pick a project id. The rest of this doc uses `$PROJECT_ID` — set it once:
  ```bash
  export PROJECT_ID=chess-platform-prod
  export REGION=us-central1
  gcloud config set project "$PROJECT_ID"
  gcloud config set run/region "$REGION"
  gcloud config set compute/region "$REGION"
  ```

## 1. One-time project setup

Create the project, enable the APIs, pick a service account for deploys.

```bash
gcloud projects create "$PROJECT_ID" --name="Chess platform"
gcloud billing projects link "$PROJECT_ID" --billing-account=<your-billing-account-id>

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  cloudtrace.googleapis.com
```

## 2. Networking (VPC + serverless connector)

Cloud Run reaches Memorystore and the etcd VM via private IPs on your VPC. A Serverless VPC Access
connector bridges Cloud Run (which lives outside your VPC by default) to the VPC.

```bash
# Default VPC "default" is auto-created with every project. Reuse it.
gcloud compute networks vpc-access connectors create chess-connector \
  --region="$REGION" \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 --max-instances=3
```

## 3. Postgres (Cloud SQL)

```bash
# Create the instance (takes 5-10 min). db-f1-micro is the cheapest supported shape.
gcloud sql instances create chess-postgres \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="$REGION" \
  --storage-size=10GB \
  --storage-type=SSD \
  --backup-start-time=03:00 \
  --no-assign-ip \
  --network=default

gcloud sql databases create chess --instance=chess-postgres
gcloud sql users create chess --instance=chess-postgres --password=<generate-a-password>
```

`--no-assign-ip` disables the public IP — Cloud Run reaches it via the VPC connector. Grab the
private IP:

```bash
PG_HOST=$(gcloud sql instances describe chess-postgres --format='value(ipAddresses[0].ipAddress)')
echo "DATABASE_URL=postgres://chess:<password>@$PG_HOST:5432/chess"
```

## 4. Redis (Memorystore)

```bash
gcloud redis instances create chess-redis \
  --size=1 \
  --region="$REGION" \
  --tier=basic \
  --redis-version=redis_7_2 \
  --network=default

REDIS_HOST=$(gcloud redis instances describe chess-redis --region="$REGION" --format='value(host)')
echo "REDIS_URL=redis://$REDIS_HOST:6379"
```

## 5. etcd (Compute Engine)

Single e2-micro VM running etcd in a container. Free-tier eligible if the project's primary region
is us-west1 / us-central1 / us-east1 (check the current list — Google changes it).

```bash
gcloud compute instances create-with-container chess-etcd \
  --zone="${REGION}-a" \
  --machine-type=e2-micro \
  --network=default \
  --subnet=default \
  --no-address \
  --container-image=quay.io/coreos/etcd:v3.5.17 \
  --container-command=/usr/local/bin/etcd \
  --container-arg=--name=node1 \
  --container-arg=--data-dir=/data/etcd \
  --container-arg=--listen-client-urls=http://0.0.0.0:2379 \
  --container-arg=--advertise-client-urls=http://etcd.internal:2379 \
  --container-arg=--listen-peer-urls=http://0.0.0.0:2380

# A stable DNS name for Cloud Run to call.
gcloud dns managed-zones create chess-internal --dns-name=internal. --visibility=private --networks=default
ETCD_IP=$(gcloud compute instances describe chess-etcd --zone="${REGION}-a" --format='value(networkInterfaces[0].networkIP)')
gcloud dns record-sets create etcd.internal. --zone=chess-internal --type=A --ttl=60 --rrdatas="$ETCD_IP"

echo "ETCD_HOSTS=http://etcd.internal:2379"
```

**Firewall**: open 2379/tcp from the VPC connector's subnet to the etcd VM:

```bash
gcloud compute firewall-rules create chess-etcd-allow \
  --network=default \
  --direction=INGRESS \
  --allow=tcp:2379 \
  --source-ranges=10.8.0.0/28
```

## 6. Secrets (Secret Manager)

```bash
# JWT signing key.
JWT_SECRET=$(openssl rand -hex 32)
printf '%s' "$JWT_SECRET" | gcloud secrets create chess-jwt-secret --data-file=-

# Postgres password (same string you used in step 3).
printf '%s' '<pg-password>' | gcloud secrets create chess-pg-password --data-file=-
```

Give the Cloud Run runtime service account read access:

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for secret in chess-jwt-secret chess-pg-password; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role=roles/secretmanager.secretAccessor
done
```

## 7. Artifact Registry (container images)

```bash
gcloud artifacts repositories create chess \
  --repository-format=docker \
  --location="$REGION" \
  --description="Chess platform images"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"
export AR_HOST="${REGION}-docker.pkg.dev/${PROJECT_ID}/chess"
```

## 8. Build + deploy backend services

Each service's existing Dockerfile is Cloud Run-ready — nothing to change. `gcloud run deploy
--source .` auto-builds via Cloud Build and pushes to Artifact Registry in one call.

Shared env for the four internal callers (matchmaker / session-router / leaderboard / game-server):

```bash
export DATABASE_URL="postgres://chess:<password>@${PG_HOST}:5432/chess"
export REDIS_URL="redis://${REDIS_HOST}:6379"
export ETCD_HOSTS="http://etcd.internal:2379"
```

Run each from the Chess repo root. The `--source .` tells gcloud to use the current directory as
the Cloud Build context; `--dockerfile` points at the service's own Dockerfile under `apps/`.

```bash
cd ~/Documents/bck-works/Chess

# 1. matchmaker (internal, min=1)
gcloud run deploy chess-matchmaker \
  --source=. --dockerfile=apps/matchmaker/Dockerfile \
  --region="$REGION" --no-allow-unauthenticated \
  --vpc-connector=chess-connector --vpc-egress=private-ranges-only \
  --min-instances=1 --max-instances=3 --cpu=1 --memory=512Mi --port=3001 \
  --set-env-vars="NODE_ENV=production,MATCHMAKER_PORT=3001,DATABASE_URL=$DATABASE_URL,REDIS_URL=$REDIS_URL"

# 2. session-router (internal, min=1)
gcloud run deploy chess-session-router \
  --source=. --dockerfile=apps/session-router/Dockerfile \
  --region="$REGION" --no-allow-unauthenticated \
  --vpc-connector=chess-connector --vpc-egress=private-ranges-only \
  --min-instances=1 --max-instances=2 --cpu=1 --memory=512Mi --port=3002 \
  --set-env-vars="NODE_ENV=production,SESSION_ROUTER_PORT=3002,ETCD_HOSTS=$ETCD_HOSTS,REDIS_URL=$REDIS_URL"

# 3. leaderboard (internal, min=1)
gcloud run deploy chess-leaderboard \
  --source=. --dockerfile=apps/leaderboard/Dockerfile \
  --region="$REGION" --no-allow-unauthenticated \
  --vpc-connector=chess-connector --vpc-egress=private-ranges-only \
  --min-instances=1 --max-instances=2 --cpu=1 --memory=512Mi --port=3004 \
  --set-env-vars="NODE_ENV=production,LEADERBOARD_PORT=3004,DATABASE_URL=$DATABASE_URL,REDIS_URL=$REDIS_URL"

# 4. game-server (public, WebSocket; min=max=1 pins to a single instance)
gcloud run deploy chess-game-server \
  --source=. --dockerfile=apps/game-server/Dockerfile \
  --region="$REGION" --allow-unauthenticated \
  --vpc-connector=chess-connector --vpc-egress=private-ranges-only \
  --min-instances=1 --max-instances=1 --cpu=1 --memory=1Gi --port=3003 \
  --session-affinity --timeout=3600 \
  --update-secrets="JWT_SECRET=chess-jwt-secret:latest" \
  --set-env-vars="NODE_ENV=production,GAME_SERVER_PORT=3003,DATABASE_URL=$DATABASE_URL,REDIS_URL=$REDIS_URL,ETCD_HOSTS=$ETCD_HOSTS"

GAME_SERVER_URL=$(gcloud run services describe chess-game-server --region="$REGION" --format='value(status.url)')
# Convert https:// → wss:// for the WS advertise URL fed to the router + browser.
GAME_SERVER_PUBLIC_URL="wss://${GAME_SERVER_URL#https://}"

# 5. gateway (public, min=0)
MATCHMAKER_URL=$(gcloud run services describe chess-matchmaker --region="$REGION" --format='value(status.url)')
SESSION_ROUTER_URL=$(gcloud run services describe chess-session-router --region="$REGION" --format='value(status.url)')
LEADERBOARD_URL=$(gcloud run services describe chess-leaderboard --region="$REGION" --format='value(status.url)')

gcloud run deploy chess-gateway \
  --source=. --dockerfile=apps/gateway/Dockerfile \
  --region="$REGION" --allow-unauthenticated \
  --vpc-connector=chess-connector --vpc-egress=private-ranges-only \
  --min-instances=0 --max-instances=5 --cpu=1 --memory=512Mi --port=3000 \
  --update-secrets="JWT_SECRET=chess-jwt-secret:latest" \
  --set-env-vars="NODE_ENV=production,GATEWAY_PORT=3000,DATABASE_URL=$DATABASE_URL,REDIS_URL=$REDIS_URL,MATCHMAKER_URL=$MATCHMAKER_URL,SESSION_ROUTER_URL=$SESSION_ROUTER_URL,LEADERBOARD_URL=$LEADERBOARD_URL,CORS_ORIGINS=<set-after-frontend>"
```

Note on auth: `--no-allow-unauthenticated` keeps the three internal services private — they
accept calls only from identities in the project. Grant the gateway's runtime SA permission to
invoke each:

```bash
GATEWAY_SA=$(gcloud run services describe chess-gateway --region="$REGION" --format='value(spec.template.spec.serviceAccountName)')
for svc in chess-matchmaker chess-session-router chess-leaderboard; do
  gcloud run services add-iam-policy-binding "$svc" \
    --region="$REGION" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role=roles/run.invoker
done
# game-server also calls session-router.
GAME_SA=$(gcloud run services describe chess-game-server --region="$REGION" --format='value(spec.template.spec.serviceAccountName)')
gcloud run services add-iam-policy-binding chess-session-router \
  --region="$REGION" \
  --member="serviceAccount:$GAME_SA" \
  --role=roles/run.invoker
```

## 9. Database migrations + seed

Open a Cloud SQL Auth proxy locally and point drizzle-kit at it:

```bash
gcloud sql connect chess-postgres --user=chess --quiet &   # auto-starts a proxy on 5432
export DATABASE_URL="postgres://chess:<password>@localhost:5432/chess"
pnpm --filter @chess/db exec drizzle-kit migrate
SEED_COUNT=20 pnpm --filter @chess/db db:seed              # optional
```

## 10. Frontend (chess-web)

The frontend Dockerfile expects both repos side-by-side (it needs `../Chess/packages/...`). Build
locally and push the image rather than using `--source .`:

```bash
cd ~/Documents/bck-works
GATEWAY_URL=$(gcloud run services describe chess-gateway --region="$REGION" --format='value(status.url)')
IMAGE="${AR_HOST}/chess-web:$(git -C chess-web rev-parse --short HEAD)"

docker build -f chess-web/Dockerfile \
  --build-arg NEXT_PUBLIC_GATEWAY_URL="$GATEWAY_URL" \
  -t "$IMAGE" .
docker push "$IMAGE"

gcloud run deploy chess-web \
  --image="$IMAGE" \
  --region="$REGION" --allow-unauthenticated \
  --min-instances=0 --max-instances=5 --cpu=1 --memory=512Mi --port=3000 \
  --set-env-vars="NEXT_PUBLIC_GATEWAY_URL=$GATEWAY_URL"

WEB_URL=$(gcloud run services describe chess-web --region="$REGION" --format='value(status.url)')
```

(`NEXT_PUBLIC_*` is baked into the Next bundle at build time, so it must be a build arg — not a
runtime env var. The Dockerfile currently reads it only at runtime, which Next ignores. If this
doesn't take effect, add `ARG NEXT_PUBLIC_GATEWAY_URL` + `ENV NEXT_PUBLIC_GATEWAY_URL` to the
build stage before `pnpm build`.)

Finally, backfill the gateway's `CORS_ORIGINS` with the web URL:

```bash
gcloud run services update chess-gateway \
  --region="$REGION" \
  --update-env-vars="CORS_ORIGINS=$WEB_URL"
```

## 11. Verify

```bash
curl -i "$GATEWAY_URL/healthz"
open "$WEB_URL"
```

Sign in as `player_000000` / `pw_player_000000` (or create an account), open a second browser,
matchmake with another seeded user. The browser's WebSocket should connect directly to
`$GAME_SERVER_URL` (no gateway in the path).

## 12. Cost estimates

For low traffic (your own testing):

| Resource                 | Monthly (approx)   |
| ------------------------ | ------------------ |
| Cloud SQL db-f1-micro    | $7–10              |
| Memorystore Basic 1GB    | $35                |
| GCE e2-micro (etcd)      | free tier, else $7 |
| Cloud Run (all services) | <$5 (mostly idle)  |
| Artifact Registry        | <$1                |
| Egress + load balancing  | ~$1                |
| **Total**                | **~$50/month**     |

The $300 free trial covers 6 months of this.

Cheaper alternative: replace Memorystore with a Redis container on the same GCE VM as etcd
(~$0 extra). Expected monthly then drops to **~$10–15/month**.

## 13. Teardown

```bash
for svc in chess-gateway chess-game-server chess-matchmaker chess-session-router chess-leaderboard chess-web; do
  gcloud run services delete "$svc" --region="$REGION" --quiet
done
gcloud compute instances delete chess-etcd --zone="${REGION}-a" --quiet
gcloud redis instances delete chess-redis --region="$REGION" --quiet
gcloud sql instances delete chess-postgres --quiet
gcloud compute networks vpc-access connectors delete chess-connector --region="$REGION" --quiet
gcloud artifacts repositories delete chess --location="$REGION" --quiet
```

## Known limitations

- **One game-server instance.** The session router's consistent-hash ring supports many, but
  per-instance addressing on Cloud Run needs the sidecar-based ingress pattern (or GKE). Fine for
  a demo; a multi-region deploy would want GKE Autopilot instead.
- **Single-node etcd.** No HA. If the e2-micro dies, the router + game-server re-register on
  boot, so recovery is a reboot not a restore.
- **Memorystore is the biggest line item.** Consider the hybrid "Redis on the etcd VM" option
  above if cost matters more than ops-ease.
- **No CDN in front of chess-web.** Next's static assets ship from the Cloud Run instance. For
  wider audiences, front with Cloud CDN or Firebase Hosting (which proxies to Cloud Run).
