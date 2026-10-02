// API gateway: REST edge for the client. Holds a long-poll for matchmaking and exposes GET /games/:id.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createDb } from '@chess/db';
import { installGracefulShutdown, registerObservability } from '@chess/telemetry';
import { createMatchSubscriber } from './match-subscriber.js';
import { createMatchmakerClient } from './matchmaker-client.js';
import { createRouterClient } from './router-client.js';
import { registerGamesRoute } from './routes/games.js';
import { registerMatchmakingRoute } from './routes/matchmaking.js';

const SERVICE = 'gateway';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);

const db = createDb(config.DATABASE_URL);
const subscriber = await createMatchSubscriber(config.REDIS_URL);
const matchmaker = createMatchmakerClient(config.MATCHMAKER_URL);
const router = createRouterClient(config.SESSION_ROUTER_URL);

app.addHook('onClose', async () => {
  await subscriber.stop();
  await db.close();
});
installGracefulShutdown(app, app.log);

registerMatchmakingRoute(app, { subscriber, matchmaker, router });
registerGamesRoute(app, { db: db.db, router });

app
  .listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
