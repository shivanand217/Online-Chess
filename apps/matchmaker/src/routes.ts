// HTTP surface the gateway talks to. POST /enqueue adds a waiter (looking up their authoritative rating
// from Postgres); DELETE /enqueue/:id cancels one (the gateway's path when the client disconnects).
// The gateway owns the requestId so it can subscribe to the match channel before enqueueing.
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { getPlayer, type Database } from '@chess/db';
import { EnqueueRequest, type EnqueueResponse } from '@chess/protocol';
import { requestKey } from './keys.js';
import { dequeue, enqueue, getWaiter } from './pool.js';

export interface RouteDeps {
  redis: Redis;
  db: Database;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.post('/enqueue', async (req, reply) => {
    const parsed = EnqueueRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }
    const { requestId, playerId, timeControl } = parsed.data;

    const player = await getPlayer(deps.db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player_not_found' };
    }

    await enqueue(deps.redis, {
      requestId,
      playerId,
      rating: player.rating,
      timeControl,
      enqueuedAt: Date.now(),
    });

    reply.code(202);
    const response: EnqueueResponse = { requestId };
    return response;
  });

  app.delete<{ Params: { requestId: string } }>('/enqueue/:requestId', async (req, reply) => {
    const { requestId } = req.params;
    const waiter = await getWaiter(deps.redis, requestId);
    if (!waiter) {
      // 204 (not 404) so the sweeper-vs-cancel race — the gateway's 15s timer firing just after the
      // sweeper has already expired the same waiter — doesn't drown out real errors. The caller's
      // intent ("make sure this isn't in the pool") is already satisfied.
      reply.code(204);
      return null;
    }
    await dequeue(deps.redis, requestId, waiter.timeControl);
    // Also nuke the hash by key in case dequeue raced with a sweep that already ZREMmed but not DELled.
    await deps.redis.del(requestKey(requestId));
    reply.code(204);
    return null;
  });
}
