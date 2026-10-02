// End-to-end: real Postgres + Redis + matchmaker (routes + sweeper) + gateway, all talking over HTTP on
// ephemeral ports. Two long-polls on the same time control must resolve to the same gameId with mirrored
// colours. Also covers the 408 path and GET /games/:id.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import { createDb, getPlayer, insertPlayer, runMigrations, type DbHandle } from '@chess/db';
import type { MatchmakingResponse } from '@chess/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript } from '@chess/matchmaker/claim';
import { startSweeper, type Sweeper } from '@chess/matchmaker/loop';
import type { ResolvePlayer } from '@chess/matchmaker/notify';
import { registerRoutes as registerMatchmakerRoutes } from '@chess/matchmaker/routes';
import { createMatchSubscriber, type MatchSubscriber } from './match-subscriber.js';
import { createMatchmakerClient } from './matchmaker-client.js';
import { registerGamesRoute } from './routes/games.js';
import { registerMatchmakingRoute } from './routes/matchmaking.js';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let db: DbHandle;
let redis: Redis;
let matchmakerApp: FastifyInstance;
let gatewayApp: FastifyInstance;
let gatewayUrl: string;
let subscriber: MatchSubscriber;
let sweeper: Sweeper | undefined;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  db = createDb(pg.getConnectionUri());
  await runMigrations(db.db);
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  redis = new Redis(redisUrl);
  registerClaimScript(redis);

  const resolvePlayer: ResolvePlayer = async (playerId) => {
    const p = await getPlayer(db.db, playerId);
    return p ? { playerId: p.playerId, username: p.username, rating: p.rating } : undefined;
  };

  matchmakerApp = Fastify({ logger: false });
  await registerMatchmakerRoutes(matchmakerApp, { redis, db: db.db });
  const matchmakerAddr = await matchmakerApp.listen({ port: 0, host: '127.0.0.1' });
  sweeper = startSweeper({ redis, db: db.db, resolvePlayer }, 50);

  subscriber = await createMatchSubscriber(redisUrl);
  const matchmaker = createMatchmakerClient(matchmakerAddr);

  gatewayApp = Fastify({ logger: false });
  registerMatchmakingRoute(gatewayApp, { subscriber, matchmaker, timeoutMs: 2_000 });
  registerGamesRoute(gatewayApp, { db: db.db });
  gatewayUrl = await gatewayApp.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  await sweeper?.stop();
  await subscriber?.stop();
  await gatewayApp?.close();
  await matchmakerApp?.close();
  redis?.disconnect();
  await db?.close();
  await Promise.all([pg?.stop(), redisContainer?.stop()]);
});

afterEach(async () => {
  await redis.flushall();
});

async function postMatchmaking(playerId: string, timeControl = 'blitz-3-2'): Promise<Response> {
  return fetch(`${gatewayUrl}/matchmaking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-player-id': playerId },
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
  });

  it('returns 408 when nobody shows up before the gateway timeout', async () => {
    const lonely = await insertPlayer(db.db, { username: `lonely-${randomUUID()}`, rating: 1500 });
    const res = await postMatchmaking(lonely.playerId);
    expect(res.status).toBe(408);
  });

  it('rejects a request missing x-player-id with 401', async () => {
    const res = await fetch(`${gatewayUrl}/matchmaking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeControl: 'blitz-3-2' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const player = await insertPlayer(db.db, { username: `bad-${randomUUID()}`, rating: 1500 });
    const res = await fetch(`${gatewayUrl}/matchmaking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-player-id': player.playerId },
      body: JSON.stringify({ wrong: 'shape' }),
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
    const body = (await res.json()) as { gameId: string; status: string; turn: string };
    expect(body.gameId).toBe(gameId);
    expect(body.status).toBe('active');
    expect(body.turn).toBe('w');
  });

  it('404s for an unknown gameId', async () => {
    const res = await fetch(`${gatewayUrl}/games/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
