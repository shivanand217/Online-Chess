// `GET /route/:gameId` → the game-server URL this gameId hashes to. The ring is swapped out whenever
// the registry watch fires, so the next request after a membership change already sees the new topology.
import type { FastifyInstance } from 'fastify';
import type { HashRing } from './ring.js';

export interface RingHolder {
  current: HashRing;
}

export function registerRoutes(app: FastifyInstance, holder: RingHolder): void {
  app.get<{ Params: { gameId: string } }>('/route/:gameId', async (req, reply) => {
    const node = holder.current.nodeFor(req.params.gameId);
    if (!node) {
      reply.code(503);
      return { error: 'no_game_servers_available' };
    }
    return { gameId: req.params.gameId, nodeId: node.id, wsUrl: node.value };
  });

  app.get('/members', async () => ({ members: holder.current.ids() }));
}
