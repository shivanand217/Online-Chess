// Integration tests for the matchmaker core (pool + atomic claim) against a real Redis via Testcontainers.
// The important invariant is Phase 2's acceptance criterion: N workers hammering a hot mid-band waiter →
// the player is booked into *exactly one* game, with no double-booking. We prove it by racing many
// concurrent claim attempts against a single waiter and asserting the winner count is 1.
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

describe('pool — enqueue/dequeue/getWaiter', () => {
  it('round-trips a waiter: pool size grows, metadata is readable, dequeue reverses both', async () => {
    const w = waiter({ rating: 1700 });
    await enqueue(redis, w);
    expect(await poolSize(redis, w.timeControl)).toBe(1);
    expect(await getWaiter(redis, w.requestId)).toEqual(w);
    await dequeue(redis, w.requestId, w.timeControl);
    expect(await poolSize(redis, w.timeControl)).toBe(0);
    expect(await getWaiter(redis, w.requestId)).toBeUndefined();
  });
});

describe('tryClaim — pairing', () => {
  it('pairs two waiters inside the window and removes both from the pool', async () => {
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

  it('returns null when no candidate sits inside the window', async () => {
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
    // Both still in pool for a later (wider) attempt.
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
    // The caller's own entry must stay in the pool so another worker can still match them.
    expect(await poolSize(redis, a.timeControl)).toBe(1);
  });
});

describe('tryClaim — concurrency (the race-free invariant)', () => {
  it('with N workers claiming against one hot waiter, exactly one wins', async () => {
    const hot = waiter({ rating: 1500 });
    await enqueue(redis, hot);

    const N = 50;
    // Each contender is their own waiter inside the window — mirrors real traffic (every arrival both
    // adds itself and attempts to claim).
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

    // Hot waiter is booked at most once (the single most important invariant).
    const winnersOfHot = results.filter((r) => r === hot.requestId);
    expect(winnersOfHot).toHaveLength(1);

    // Broader invariant: no requestId appears as a winner twice. Each successful ZREM in the Lua
    // script returns 1 only once, so no two callers can ever have claimed the same peer.
    const winners = results.filter((r): r is string => r !== null);
    expect(new Set(winners).size).toBe(winners.length);

    // Nobody paired with themselves.
    for (let i = 0; i < contenders.length; i++) {
      expect(results[i]).not.toBe(contenders[i]?.requestId);
    }
  });
});
