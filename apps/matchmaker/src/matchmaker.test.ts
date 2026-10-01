// Integration tests against a real Redis via Testcontainers. The concurrency test is the one that
// matters: N workers racing against a single hot waiter must produce at most one winner.
import { randomUUID } from 'node:crypto';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerClaimScript, tryClaim } from './claim.js';
import { dequeue, enqueue, getWaiter, poolSize, type WaiterMetadata } from './pool.js';

let container: StartedTestContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
  registerClaimScript(redis);
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

afterEach(async () => {
  await redis.flushall();
});

function waiter(overrides: Partial<WaiterMetadata> = {}): WaiterMetadata {
  return {
    requestId: randomUUID(),
    playerId: randomUUID(),
    rating: 1500,
    timeControl: 'blitz-3-2',
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

describe('pool', () => {
  it('round-trips a waiter: enqueue populates the pool and metadata; dequeue reverses both', async () => {
    const w = waiter({ rating: 1700 });
    await enqueue(redis, w);
    expect(await poolSize(redis, w.timeControl)).toBe(1);
    expect(await getWaiter(redis, w.requestId)).toEqual(w);
    await dequeue(redis, w.requestId, w.timeControl);
    expect(await poolSize(redis, w.timeControl)).toBe(0);
    expect(await getWaiter(redis, w.requestId)).toBeUndefined();
  });
});

describe('tryClaim', () => {
  it('pairs two waiters inside the window and removes both', async () => {
    const a = waiter({ rating: 1500 });
    const b = waiter({ rating: 1520 });
    await enqueue(redis, a);
    await enqueue(redis, b);

    const peer = await tryClaim(redis, {
      timeControl: a.timeControl,
      requestId: a.requestId,
      rating: a.rating,
      window: 50,
    });

    expect(peer).toBe(b.requestId);
    expect(await poolSize(redis, a.timeControl)).toBe(0);
  });

  it('returns null when nothing is in range (both waiters remain)', async () => {
    const a = waiter({ rating: 1500 });
    const far = waiter({ rating: 2500 });
    await enqueue(redis, a);
    await enqueue(redis, far);

    const peer = await tryClaim(redis, {
      timeControl: a.timeControl,
      requestId: a.requestId,
      rating: a.rating,
      window: 100,
    });

    expect(peer).toBeNull();
    expect(await poolSize(redis, a.timeControl)).toBe(2);
  });

  it('never pairs a waiter with themselves', async () => {
    const a = waiter({ rating: 1500 });
    await enqueue(redis, a);

    const peer = await tryClaim(redis, {
      timeControl: a.timeControl,
      requestId: a.requestId,
      rating: a.rating,
      window: 50,
    });

    expect(peer).toBeNull();
    expect(await poolSize(redis, a.timeControl)).toBe(1);
  });

  it('with N workers racing one hot waiter, no two callers claim the same peer', async () => {
    const hot = waiter({ rating: 1500 });
    await enqueue(redis, hot);

    const N = 50;
    const contenders = Array.from({ length: N }, () => waiter({ rating: 1500 }));
    await Promise.all(contenders.map((c) => enqueue(redis, c)));

    const results = await Promise.all(
      contenders.map((c) =>
        tryClaim(redis, {
          timeControl: c.timeControl,
          requestId: c.requestId,
          rating: c.rating,
          window: 50,
        }),
      ),
    );

    expect(results.filter((r) => r === hot.requestId)).toHaveLength(1);

    const winners = results.filter((r): r is string => r !== null);
    expect(new Set(winners).size).toBe(winners.length);

    for (let i = 0; i < contenders.length; i++) {
      expect(results[i]).not.toBe(contenders[i]?.requestId);
    }
  });
});
