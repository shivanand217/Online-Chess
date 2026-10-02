// Sweeper integration against real Postgres + Redis. We call `tick` directly with an injected clock so
// widening and expiry are deterministic (no `vi.useFakeTimers` + no real sleeps). The gateway's flow is
// mimicked by subscribing to the match channel before enqueueing.
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import { createDb, insertPlayer, runMigrations, type DbHandle } from '@chess/db';
import type { MatchResult } from '@chess/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript } from './claim.js';
import { matchChannel, requestKey } from './keys.js';
import { tick } from './loop.js';
import type { ResolvePlayer } from './notify.js';
import { enqueue, poolSize, type WaiterMetadata } from './pool.js';
import { DEFAULT_WIDEN } from './widen.js';

let pg: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let db: DbHandle;
let redis: Redis;
let sub: Redis;

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
  redis?.disconnect();
  sub?.disconnect();
  await db?.close();
  await Promise.all([pg?.stop(), redisContainer?.stop()]);
});

afterEach(async () => {
  await redis.flushall();
});

function once(channel: string, timeoutMs = 2_000): Promise<MatchResult> {
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

async function seedWaiter(
  prefix: string,
  rating: number,
  enqueuedAt = Date.now(),
): Promise<WaiterMetadata> {
  const player = await insertPlayer(db.db, { username: `${prefix}-${randomUUID()}`, rating });
  const waiter: WaiterMetadata = {
    requestId: randomUUID(),
    playerId: player.playerId,
    rating,
    timeControl: 'blitz-3-2',
    enqueuedAt,
  };
  await enqueue(redis, waiter);
  return waiter;
}

const resolveFromDb: ResolvePlayer = async (playerId) => {
  const p = await db.db.query.players.findFirst({
    where: (row, { eq }) => eq(row.playerId, playerId),
  });
  return p ? { playerId: p.playerId, username: p.username, rating: p.rating } : undefined;
};

describe('tick', () => {
  it('pairs two in-window waiters and publishes a matched payload to both', async () => {
    const alice = await seedWaiter('alice', 1500);
    const bob = await seedWaiter('bob', 1510);

    const aliceInbox = once(matchChannel(alice.requestId));
    const bobInbox = once(matchChannel(bob.requestId));

    const stats = await tick({ redis, db: db.db, resolvePlayer: resolveFromDb });

    expect(stats.claimed).toBeGreaterThanOrEqual(1);
    const [a, b] = await Promise.all([aliceInbox, bobInbox]);
    expect(a.type).toBe('matched');
    expect(b.type).toBe('matched');
    expect(await poolSize(redis, alice.timeControl)).toBe(0);
  });

  it('does not pair an extreme-rating waiter with the initial narrow window', async () => {
    await seedWaiter('mid', 1500);
    await seedWaiter('far', 2500);

    // now = enqueuedAt → window is DEFAULT_WIDEN.initialWindow (50). 1000-point gap can't match.
    const stats = await tick({
      redis,
      db: db.db,
      resolvePlayer: resolveFromDb,
      now: () => Date.now(),
    });

    expect(stats.claimed).toBe(0);
    expect(await poolSize(redis, 'blitz-3-2')).toBe(2);
  });

  it('expires a waiter past maxWaitMs and publishes an expired payload', async () => {
    const now = Date.now();
    const stale = await seedWaiter('stale', 1500, now - DEFAULT_WIDEN.maxWaitMs - 1_000);

    const inbox = once(matchChannel(stale.requestId));
    const stats = await tick({
      redis,
      db: db.db,
      resolvePlayer: resolveFromDb,
      now: () => now,
    });

    expect(stats.expired).toBe(1);
    const payload = await inbox;
    expect(payload.type).toBe('expired');
    expect(await poolSize(redis, stale.timeControl)).toBe(0);
    expect(await redis.exists(requestKey(stale.requestId))).toBe(0);
  });
});
