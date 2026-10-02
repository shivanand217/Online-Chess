// HTTP surface tested in-process (fastify.inject) against real Postgres + Redis. We also start a sweeper
// so the enqueue path is exercised end-to-end: two POSTs → sweep → both channels receive matched payloads.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import { createDb, insertPlayer, runMigrations, type DbHandle } from '@chess/db';
import type { EnqueueResponse, MatchResult } from '@chess/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript } from './claim.js';
import { matchChannel } from './keys.js';
import { startSweeper, type Sweeper } from './loop.js';
import type { ResolvePlayer } from './notify.js';
import { poolSize } from './pool.js';
import { registerRoutes } from './routes.js';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let db: DbHandle;
let redis: Redis;
let sub: Redis;
let sweeper: Sweeper | undefined;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  db = createDb(pg.getConnectionUri());
  await runMigrations(db.db);
  const host = redisContainer.getHost();
  const port = redisContainer.getMappedPort(6379);
  redis = new Redis({ host, port });
  sub = new Redis({ host, port });
  registerClaimScript(redis);
}, 120_000);

afterAll(async () => {
  await sweeper?.stop();
  redis?.disconnect();
  sub?.disconnect();
  await db?.close();
  await Promise.all([pg?.stop(), redisContainer?.stop()]);
});

afterEach(async () => {
  await sweeper?.stop();
  sweeper = undefined;
  await redis.flushall();
});

async function makeApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });
  await registerRoutes(app, { redis, db: db.db });
  return app;
}

const resolveFromDb: ResolvePlayer = async (playerId) => {
  const p = await db.db.query.players.findFirst({
    where: (row, { eq }) => eq(row.playerId, playerId),
  });
  return p ? { playerId: p.playerId, username: p.username, rating: p.rating } : undefined;
};

function once(channel: string, timeoutMs = 3_000): Promise<MatchResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${channel}`)), timeoutMs);
    const onMessage = (ch: string, msg: string): void => {
      if (ch !== channel) return;
      clearTimeout(timer);
      sub.off('message', onMessage);
      sub.unsubscribe(channel).catch(() => undefined);
      resolve(JSON.parse(msg) as MatchResult);
    };
    sub.on('message', onMessage);
    sub.subscribe(channel).catch(reject);
  });
}

async function enqueueOne(
  app: Awaited<ReturnType<typeof makeApp>>,
  playerId: string,
  requestId: string,
): Promise<EnqueueResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/enqueue',
    payload: { requestId, playerId, timeControl: 'blitz-3-2' },
  });
  expect(res.statusCode).toBe(202);
  return res.json() as EnqueueResponse;
}

describe('POST /enqueue', () => {
  it('rejects an unknown player with 404', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/enqueue',
      payload: { requestId: randomUUID(), playerId: randomUUID(), timeControl: 'blitz-3-2' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('rejects a malformed body with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/enqueue', payload: { nope: true } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('enqueues both players and the sweeper pairs them (channels receive matched)', async () => {
    const app = await makeApp();
    sweeper = startSweeper({ redis, db: db.db, resolvePlayer: resolveFromDb }, 50);

    const alice = await insertPlayer(db.db, { username: `alice-${randomUUID()}`, rating: 1500 });
    const bob = await insertPlayer(db.db, { username: `bob-${randomUUID()}`, rating: 1510 });

    const aliceReq = randomUUID();
    const bobReq = randomUUID();
    const aliceInbox = once(matchChannel(aliceReq));
    const bobInbox = once(matchChannel(bobReq));

    await enqueueOne(app, alice.playerId, aliceReq);
    await enqueueOne(app, bob.playerId, bobReq);

    const [aliceMsg, bobMsg] = await Promise.all([aliceInbox, bobInbox]);
    expect(aliceMsg.type).toBe('matched');
    expect(bobMsg.type).toBe('matched');
    if (aliceMsg.type === 'matched' && bobMsg.type === 'matched') {
      expect(aliceMsg.gameId).toBe(bobMsg.gameId);
    }
    expect(await poolSize(redis, 'blitz-3-2')).toBe(0);
    await app.close();
  });
});

describe('DELETE /enqueue/:requestId', () => {
  it('cancels a pending waiter and empties the pool', async () => {
    const app = await makeApp();
    const alice = await insertPlayer(db.db, { username: `alice-${randomUUID()}`, rating: 1500 });
    const aliceReq = randomUUID();
    await enqueueOne(app, alice.playerId, aliceReq);
    expect(await poolSize(redis, 'blitz-3-2')).toBe(1);

    const res = await app.inject({ method: 'DELETE', url: `/enqueue/${aliceReq}` });
    expect(res.statusCode).toBe(204);
    expect(await poolSize(redis, 'blitz-3-2')).toBe(0);
    await app.close();
  });

  it('is a no-op (204) when the requestId is unknown', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'DELETE', url: `/enqueue/${randomUUID()}` });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
