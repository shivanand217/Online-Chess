// The waiting pool is a Redis sorted set per time control, scored by rating. Enqueue writes two things:
// the ZADD into the pool, and an HSET of the waiter's metadata (looked up at pairing time). We do them
// together in a pipeline so a waiter is either fully present or fully absent — never half-registered.
// A matching dequeue is provided for the void-and-requeue path (gateway sees the client is gone).
// Hand-written.
import type Redis from 'ioredis';
import { poolKey, requestKey } from './keys.js';

/** The one row the pairing step needs about a waiter — kept narrow so the hash stays cheap. */
export interface WaiterMetadata {
  requestId: string;
  playerId: string;
  rating: number;
  timeControl: string;
  /** Epoch ms when the waiter joined — the widening-window pass reads this to decide its search band. */
  enqueuedAt: number;
}

/** Add a waiter to the pool and record its metadata atomically-enough (one pipeline, one round-trip). */
export async function enqueue(redis: Redis, waiter: WaiterMetadata): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.zadd(poolKey(waiter.timeControl), waiter.rating, waiter.requestId);
  pipeline.hset(requestKey(waiter.requestId), {
    playerId: waiter.playerId,
    rating: String(waiter.rating),
    timeControl: waiter.timeControl,
    enqueuedAt: String(waiter.enqueuedAt),
  });
  await pipeline.exec();
}

/** Remove a waiter (void-and-requeue, or gateway cancels after client disconnect). */
export async function dequeue(redis: Redis, requestId: string, timeControl: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.zrem(poolKey(timeControl), requestId);
  pipeline.del(requestKey(requestId));
  await pipeline.exec();
}

/** Current number of waiters for a time control (metrics / smoke tests). */
export async function poolSize(redis: Redis, timeControl: string): Promise<number> {
  return redis.zcard(poolKey(timeControl));
}

/** Hydrate a waiter's metadata hash. Returns undefined if the request has been dequeued already. */
export async function getWaiter(
  redis: Redis,
  requestId: string,
): Promise<WaiterMetadata | undefined> {
  const row = await redis.hgetall(requestKey(requestId));
  if (!row.playerId || !row.timeControl) return undefined;
  return {
    requestId,
    playerId: row.playerId,
    rating: Number(row.rating),
    timeControl: row.timeControl,
    enqueuedAt: Number(row.enqueuedAt),
  };
}
