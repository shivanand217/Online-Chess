// Session router: watches etcd for live game-server membership and routes each gameId to one of them via
// a consistent-hash ring. Both players of a game end up on the same server because the lookup is pure
// over gameId.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createRegistry } from '@chess/registry';
import {
  createGenReqId,
  installGracefulShutdown,
  registerObservability,
  pinoTraceMixin,
} from '@chess/telemetry';
import { ringMembers } from './metrics.js';
import { HashRing, type RingNode } from './ring.js';
import { registerRoutes, type RingHolder } from './routes.js';

const SERVICE = 'session-router';
const config = loadConfig();
const GAME_SERVERS_PREFIX = '/chess/game-servers/';

const app = Fastify({
  logger: { name: SERVICE, level: config.LOG_LEVEL, mixin: pinoTraceMixin },
  genReqId: createGenReqId(),
});
registerObservability(app);

const registry = createRegistry({ hosts: config.ETCD_HOSTS });
const holder: RingHolder = { current: new HashRing([]) };

app.addHook('onClose', async () => {
  await registry.close();
});
installGracefulShutdown(app, app.log);

registerRoutes(app, holder);

app
  .listen({ port: config.SESSION_ROUTER_PORT, host: '0.0.0.0' })
  .then(async (addr) => {
    await registry.watch(GAME_SERVERS_PREFIX, (members) => {
      const nodes: RingNode[] = [...members].map(([id, value]) => ({ id, value }));
      holder.current = new HashRing(nodes);
      ringMembers.set(nodes.length);
      app.log.info({ members: nodes.map((n) => n.id) }, 'ring updated');
    });
    app.log.info({ addr }, `${SERVICE} listening`);
  })
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
