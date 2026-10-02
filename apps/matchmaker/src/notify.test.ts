// End-to-end for the claim → persist → publish → cleanup path. Real Postgres + Redis via Testcontainers:
// seed two players, enqueue them, claim, notify, and assert the Game row, the two pub/sub payloads, and
// the hash cleanup. One Postgres and one Redis container for the file.
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import Redis from 'ioredis';
import { createDb, getGame, insertPlayer, runMigrations, type DbHandle } from '@chess/db';
import type { MatchNotification } from '@chess/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript, tryClaim } from './claim.js';
import { matchChannel, requestKey } from './keys.js';
import { notifyPairing, type ResolvePlayer } from './notify.js';
import { enqueue, type WaiterMetadata } from './pool.js';

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

/** Collect messages on a channel into a promise that resolves after `expectedCount` payloads arrive. */
function collect(channel: string, expectedCount: number, timeoutMs = 2_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const got: string[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${channel}, got ${got.length}/${expectedCount}`)),
      timeoutMs,
    );
    const onMessage = (ch: string, msg: string): void => {
      if (ch !== channel) return;
      got.push(msg);
      if (got.length >= expectedCount) {
        clearTimeout(timer);
        sub.off('message', onMessage);
        sub.unsubscribe(channel).catch(() => undefined);
        resolve(got);
      }
    };
    sub.on('message', onMessage);
    sub.subscribe(channel).catch(reject);
  });
}

async function seedWaiter(username: string, rating: number): Promise<WaiterMetadata> {
  const player = await insertPlayer(db.db, { username: `${username}-${randomUUID()}`, rating });
  const waiter: WaiterMetadata = {
    requestId: randomUUID(),
    playerId: player.playerId,
    rating,
    timeControl: 'blitz-3-2',
    enqueuedAt: Date.now(),
  };
  await enqueue(redis, waiter);
  return waiter;
}

const resolveFromDb: ResolvePlayer = async (playerId) => {
  const rows = await db.db.query.players.findFirst({
    where: (p, { eq }) => eq(p.playerId, playerId),
  });
  return rows
    ? { playerId: rows.playerId, username: rows.username, rating: rows.rating }
    : undefined;
};

describe('notifyPairing', () => {
  it('creates the game, publishes mirrored payloads to both channels, cleans up metadata', async () => {
    const alice = await seedWaiter('alice', 1500);
    const bob = await seedWaiter('bob', 1510);

    const peer = await tryClaim(redis, {
      timeControl: alice.timeControl,
      requestId: alice.requestId,
      rating: alice.rating,
      window: 50,
    });
    expect(peer).toBe(bob.requestId);

    // Subscribe before publishing — mirrors the gateway's long-poll flow.
    const aliceInbox = collect(matchChannel(alice.requestId), 1);
    const bobInbox = collect(matchChannel(bob.requestId), 1);

    const result = await notifyPairing(redis, db.db, {
      callerRequestId: alice.requestId,
      peerRequestId: bob.requestId,
      resolvePlayer: resolveFromDb,
    });

    expect(result).not.toBeNull();
    const [aliceMsg] = (await aliceInbox).map((s) => JSON.parse(s) as MatchNotification);
    const [bobMsg] = (await bobInbox).map((s) => JSON.parse(s) as MatchNotification);

    expect(aliceMsg?.type).toBe('matched');
    expect(bobMsg?.type).toBe('matched');
    expect(aliceMsg?.gameId).toBe(result?.gameId);
    expect(bobMsg?.gameId).toBe(result?.gameId);
    expect(aliceMsg?.color).not.toBe(bobMsg?.color);
    expect(aliceMsg?.opponent.playerId).toBe(bob.playerId);
    expect(bobMsg?.opponent.playerId).toBe(alice.playerId);

    const game = await getGame(db.db, result?.gameId ?? '');
    expect(game?.status).toBe('active');
    expect(game?.whiteMs).toBe(180_000);
    expect(game?.blackMs).toBe(180_000);
    expect(game?.turn).toBe('w');

    // Metadata hashes are gone (sweeper has nothing to GC).
    expect(await redis.exists(requestKey(alice.requestId))).toBe(0);
    expect(await redis.exists(requestKey(bob.requestId))).toBe(0);
  });

  it('returns null if a prior notify already resolved the pairing (crash-replay safety)', async () => {
    const alice = await seedWaiter('alice', 1500);
    const bob = await seedWaiter('bob', 1510);

    // Simulate the first notify having already run and cleaned up.
    await redis.del(requestKey(alice.requestId), requestKey(bob.requestId));

    const result = await notifyPairing(redis, db.db, {
      callerRequestId: alice.requestId,
      peerRequestId: bob.requestId,
      resolvePlayer: resolveFromDb,
    });
    expect(result).toBeNull();
  });
});
