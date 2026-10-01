// Waiting pool read/write helpers. Enqueue pipelines ZADD + HSET so a waiter is either fully present or
// fully absent — never half-registered if the client dies between the two writes.
import type Redis from 'ioredis';
import { poolKey, requestKey } from './keys.js';

export interface WaiterMetadata {
  requestId: string;
  playerId: string;
  rating: number;
  timeControl: string;
  /** Epoch ms the waiter joined — the widener uses this to grow its search band. */
  enqueuedAt: number;
}

export async function enqueue(redis: Redis, waiter: WaiterMetadata): Promise<void> {
  await redis
    .pipeline()
    .zadd(poolKey(waiter.timeControl), waiter.rating, waiter.requestId)
    .hset(requestKey(waiter.requestId), {
      playerId: waiter.playerId,
      rating: String(waiter.rating),
      timeControl: waiter.timeControl,
      enqueuedAt: String(waiter.enqueuedAt),
    })
    .exec();
}

export async function dequeue(redis: Redis, requestId: string, timeControl: string): Promise<void> {
  await redis.pipeline().zrem(poolKey(timeControl), requestId).del(requestKey(requestId)).exec();
}

export async function poolSize(redis: Redis, timeControl: string): Promise<number> {
  return redis.zcard(poolKey(timeControl));
}

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
