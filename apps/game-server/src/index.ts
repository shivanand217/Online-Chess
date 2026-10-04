// Game server: stateful, in-memory gameplay over WebSockets. Fastify owns /healthz/readyz/metrics; the
// `ws` server attaches to the same underlying Node HTTP server for upgrades on /ws/games/:gameId. On
// startup it registers itself in etcd so the session router can pin games to this instance.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createDb } from '@chess/db';
import { createRegistry } from '@chess/registry';
import { createGenReqId, installGracefulShutdown, registerObservability } from '@chess/telemetry';
import { SessionManager } from './sessions.js';
import { WsHub } from './ws.js';

const SERVICE = 'game-server';
const INSTANCE_ID = randomUUID();
const GAME_SERVERS_PREFIX = '/chess/game-servers/';
const config = loadConfig();

const app = Fastify({
  logger: { name: SERVICE, level: config.LOG_LEVEL },
  genReqId: createGenReqId(),
});
registerObservability(app);

const db = createDb(config.DATABASE_URL);
const sessions = new SessionManager(db.db);
const hub = new WsHub({ db: db.db, sessions });
const registry = createRegistry({ hosts: config.ETCD_HOSTS });

app.addHook('onClose', async () => {
  hub.stop();
  await registry.close();
  await db.close();
});
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.GAME_SERVER_PORT, host: '0.0.0.0' })
  .then(async (addr) => {
    hub.attach(app.server);
    await registry.register(GAME_SERVERS_PREFIX, INSTANCE_ID, config.GAME_SERVER_PUBLIC_URL);
    app.log.info(
      { addr, instanceId: INSTANCE_ID, advertise: config.GAME_SERVER_PUBLIC_URL },
      `${SERVICE} listening`,
    );
  })
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
