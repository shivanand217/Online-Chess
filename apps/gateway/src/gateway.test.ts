// End-to-end: real Postgres + Redis + matchmaker (routes + sweeper) + gateway, all talking over HTTP on
// ephemeral ports. Two long-polls on the same time control must resolve to the same gameId with mirrored
// colours. Also covers the 408 path and GET /games/:id.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import { createDb, getPlayer, insertPlayer, runMigrations, type DbHandle } from '@chess/db';
import type { MatchmakingResponse } from '@chess/protocol';
import { createRegistry, type RegistryClient } from '@chess/registry';
import { HashRing, type RingNode } from '@chess/session-router/ring';
import {
  registerRoutes as registerRouterRoutes,
  type RingHolder,
} from '@chess/session-router/routes';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript } from '@chess/matchmaker/claim';
import { startSweeper, type Sweeper } from '@chess/matchmaker/loop';
import type { ResolvePlayer } from '@chess/matchmaker/notify';
import { registerRoutes as registerMatchmakerRoutes } from '@chess/matchmaker/routes';
import { registerAuth } from './auth.js';
import { createMatchSubscriber, type MatchSubscriber } from './match-subscriber.js';
import { createMatchmakerClient } from './matchmaker-client.js';
import { createRouterClient } from './router-client.js';
import { registerGamesRoute } from './routes/games.js';
import { registerMatchmakingRoute } from './routes/matchmaking.js';

const FAKE_GAME_SERVER_URL = 'ws://game-server-fake:3003';
const GAME_SERVERS_PREFIX = '/chess/game-servers/';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let etcdContainer: StartedTestContainer;
let db: DbHandle;
let redis: Redis;
let matchmakerApp: FastifyInstance;
let routerApp: FastifyInstance;
let gatewayApp: FastifyInstance;
let gatewayUrl: string;
let subscriber: MatchSubscriber;
let sweeper: Sweeper | undefined;
let registry: RegistryClient;
let routerWatcher: RegistryClient;

beforeAll(async () => {
  [pg, redisContainer, etcdContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new GenericContainer('quay.io/coreos/etcd:v3.5.17')
      .withCommand([
        '/usr/local/bin/etcd',
        '--listen-client-urls=http://0.0.0.0:2379',
        '--advertise-client-urls=http://0.0.0.0:2379',
      ])
      .withExposedPorts(2379)
      .withWaitStrategy(Wait.forLogMessage(/ready to serve client requests/))
      .start(),
  ]);
  db = createDb(pg.getConnectionUri());
  await runMigrations(db.db);
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  redis = new Redis(redisUrl);
  registerClaimScript(redis);

  const etcdUrl = `http://${etcdContainer.getHost()}:${etcdContainer.getMappedPort(2379)}`;

  const resolvePlayer: ResolvePlayer = async (playerId) => {
    const p = await getPlayer(db.db, playerId);
    return p ? { playerId: p.playerId, username: p.username, rating: p.rating } : undefined;
  };

  matchmakerApp = Fastify({ logger: false });
  await registerMatchmakerRoutes(matchmakerApp, { redis, db: db.db });
  const matchmakerAddr = await matchmakerApp.listen({ port: 0, host: '127.0.0.1' });
  sweeper = startSweeper({ redis, db: db.db, resolvePlayer }, 50);

  // Stand up a session-router instance with a live etcd watch, and register one fake game-server member
  // so the ring is non-empty by the time the gateway queries it.
  routerWatcher = createRegistry({ hosts: etcdUrl });
  const holder: RingHolder = { current: new HashRing([]) };
  await routerWatcher.watch(GAME_SERVERS_PREFIX, (members) => {
    const nodes: RingNode[] = [...members].map(([id, value]) => ({ id, value }));
    holder.current = new HashRing(nodes);
  });

  registry = createRegistry({ hosts: etcdUrl });
  await registry.register(GAME_SERVERS_PREFIX, `fake-${randomUUID()}`, FAKE_GAME_SERVER_URL);

  // Give etcd a moment to notify the watcher.
  for (let i = 0; i < 60 && holder.current.size() === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }

  routerApp = Fastify({ logger: false });
  registerRouterRoutes(routerApp, holder);
  const routerAddr = await routerApp.listen({ port: 0, host: '127.0.0.1' });

  subscriber = await createMatchSubscriber(redisUrl);
  const matchmaker = createMatchmakerClient(matchmakerAddr);
  const router = createRouterClient(routerAddr);

  gatewayApp = Fastify({ logger: false });
  await registerAuth(gatewayApp, {
    db: db.db,
    secret: 'test-secret-16-chars-min',
    expiresIn: '1h',
  });
  registerMatchmakingRoute(gatewayApp, { subscriber, matchmaker, router, timeoutMs: 2_000 });
  registerGamesRoute(gatewayApp, { db: db.db, router });
  gatewayUrl = await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  await sweeper?.stop();
  await subscriber?.stop();
  await gatewayApp?.close();
  await matchmakerApp?.close();
  await routerApp?.close();
  await registry?.close();
  await routerWatcher?.close();
  redis?.disconnect();
  await db?.close();
  await Promise.all([pg?.stop(), redisContainer?.stop(), etcdContainer?.stop()]);
});

afterEach(async () => {
  await redis.flushall();
});

async function mintToken(playerId: string): Promise<string> {
  const res = await fetch(`${gatewayUrl}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function postMatchmaking(playerId: string, timeControl = 'blitz-3-2'): Promise<Response> {
  const token = await mintToken(playerId);
  return fetch(`${gatewayUrl}/matchmaking`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ timeControl }),
  });
}

describe('POST /matchmaking (end-to-end)', () => {
  it('pairs two concurrent long-polls on the same time control', async () => {
    const alice = await insertPlayer(db.db, { username: `alice-${randomUUID()}`, rating: 1500 });
    const bob = await insertPlayer(db.db, { username: `bob-${randomUUID()}`, rating: 1510 });

    const [aliceRes, bobRes] = await Promise.all([
      postMatchmaking(alice.playerId),
      postMatchmaking(bob.playerId),
    ]);

    expect(aliceRes.status).toBe(200);
    expect(bobRes.status).toBe(200);

    const aliceBody = (await aliceRes.json()) as MatchmakingResponse;
    const bobBody = (await bobRes.json()) as MatchmakingResponse;
    expect(aliceBody.gameId).toBe(bobBody.gameId);
    expect(aliceBody.color).not.toBe(bobBody.color);
    expect(aliceBody.opponent.playerId).toBe(bob.playerId);
    expect(bobBody.opponent.playerId).toBe(alice.playerId);
    // Both long-polls carry the same session-router verdict.
    expect(aliceBody.wsUrl).toBe(FAKE_GAME_SERVER_URL);
    expect(bobBody.wsUrl).toBe(FAKE_GAME_SERVER_URL);
  });

  it('returns 408 when nobody shows up before the gateway timeout', async () => {
    const lonely = await insertPlayer(db.db, { username: `lonely-${randomUUID()}`, rating: 1500 });
    const res = await postMatchmaking(lonely.playerId);
    expect(res.status).toBe(408);
  });

  it('rejects a request with no Authorization header (401)', async () => {
    const res = await fetch(`${gatewayUrl}/matchmaking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeControl: 'blitz-3-2' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a bogus token (401)', async () => {
    const res = await fetch(`${gatewayUrl}/matchmaking`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not.a.jwt',
      },
      body: JSON.stringify({ timeControl: 'blitz-3-2' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const player = await insertPlayer(db.db, { username: `bad-${randomUUID()}`, rating: 1500 });
    const token = await mintToken(player.playerId);
    const res = await fetch(`${gatewayUrl}/matchmaking`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ wrong: 'shape' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/token', () => {
  it('mints a JWT for a known playerId', async () => {
    const player = await insertPlayer(db.db, { username: `auth-${randomUUID()}`, rating: 1500 });
    const res = await fetch(`${gatewayUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: player.playerId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; playerId: string; username: string };
    expect(body.playerId).toBe(player.playerId);
    expect(body.username).toBe(player.username);
    // A JWT is three base64url segments separated by dots.
    expect(body.token.split('.')).toHaveLength(3);
  });

  it('404s for an unknown playerId', async () => {
    const res = await fetch(`${gatewayUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on malformed body', async () => {
    const res = await fetch(`${gatewayUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /games/:id', () => {
  it('returns the game after a successful pairing', async () => {
    const alice = await insertPlayer(db.db, { username: `alice-${randomUUID()}`, rating: 1500 });
    const bob = await insertPlayer(db.db, { username: `bob-${randomUUID()}`, rating: 1510 });

    const [aliceRes] = await Promise.all([
      postMatchmaking(alice.playerId),
      postMatchmaking(bob.playerId),
    ]);
    const { gameId } = (await aliceRes.json()) as MatchmakingResponse;

    const res = await fetch(`${gatewayUrl}/games/${gameId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gameId: string;
      status: string;
      turn: string;
      wsUrl?: string;
    };
    expect(body.gameId).toBe(gameId);
    expect(body.status).toBe('active');
    expect(body.turn).toBe('w');
    // Active game → router gave us a URL.
    expect(body.wsUrl).toBe(FAKE_GAME_SERVER_URL);
  });

  it('404s for an unknown gameId', async () => {
    const res = await fetch(`${gatewayUrl}/games/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
