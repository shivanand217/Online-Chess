// Game server: stateful, in-memory gameplay over WebSockets. Fastify owns /healthz/readyz/metrics; the
// `ws` server attaches to the same underlying Node HTTP server for upgrades on /ws/games/:gameId.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createDb } from '@chess/db';
import { installGracefulShutdown, registerObservability } from '@chess/telemetry';
import { SessionManager } from './sessions.js';
import { WsHub } from './ws.js';

const SERVICE = 'game-server';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);

const db = createDb(config.DATABASE_URL);
const sessions = new SessionManager(db.db);
const hub = new WsHub({ db: db.db, sessions });

app.addHook('onClose', async () => {
  await db.close();
});
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.GAME_SERVER_PORT, host: '0.0.0.0' })
  .then((addr) => {
    hub.attach(app.server);
    app.log.info({ addr }, `${SERVICE} listening`);
  })
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
