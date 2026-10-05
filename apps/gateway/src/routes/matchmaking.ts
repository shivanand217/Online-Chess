// POST /matchmaking — a held HTTP request that resolves when the matchmaker pairs the caller. The order
// of operations matters: register the listener FIRST, then enqueue. If the sweeper happens to pair us
// before enqueue returns, the publish still lands in our listener because PSUBSCRIBE is already active.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { MatchmakingRequest, type MatchmakingResponse } from '@chess/protocol';
import type { MatchSubscriber } from '../match-subscriber.js';
import type { MatchmakerClient } from '../matchmaker-client.js';
import { matchmakingOutcomes } from '../metrics.js';
import type { RouterClient } from '../router-client.js';

export interface MatchmakingDeps {
  subscriber: MatchSubscriber;
  matchmaker: MatchmakerClient;
  router: RouterClient;
  /** Max time the gateway holds the connection before giving up with 408. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function registerMatchmakingRoute(app: FastifyInstance, deps: MatchmakingDeps): void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  app.post('/matchmaking', async (req, reply) => {
    const parsed = MatchmakingRequest.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_request', details: parsed.error.flatten() };
    }
    const playerId = req.headers['x-player-id'];
    if (typeof playerId !== 'string' || playerId.length === 0) {
      reply.code(401);
      return { error: 'missing_player_id' };
    }

    const requestId = randomUUID();
    const pending = deps.subscriber.waitFor(requestId, timeoutMs);

    try {
      await deps.matchmaker.enqueue({
        requestId,
        playerId,
        timeControl: parsed.data.timeControl,
      });
    } catch (err) {
      req.log.error({ err, requestId }, 'enqueue failed');
      matchmakingOutcomes.inc({ outcome: 'enqueue_error' });
      reply.code(502);
      return { error: 'matchmaker_unavailable' };
    }

    const result = await pending;

    if (!result || result.type === 'expired') {
      await deps.matchmaker.cancel(requestId);
      matchmakingOutcomes.inc({ outcome: result ? 'expired' : 'timeout' });
      reply.code(408);
      return { error: 'match_timeout' };
    }

    const route = await deps.router.routeFor(result.gameId);
    const response: MatchmakingResponse = {
      gameId: result.gameId,
      color: result.color,
      opponent: result.opponent,
      timeControl: result.timeControl,
      ...(route ? { wsUrl: route.wsUrl } : {}),
    };
    matchmakingOutcomes.inc({ outcome: 'matched' });
    return response;
  });
}
