// Matchmaker worker: looks up player ratings, enqueues waiters into the Redis pool, and runs the sweeper
// that pairs them off. The gateway drives it via POST /enqueue + DELETE /enqueue/:id.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createDb, getPlayer } from '@chess/db';
import { createRedis } from '@chess/redis';
import { registerObservability, installGracefulShutdown } from '@chess/telemetry';
import { registerClaimScript } from './claim.js';
import { startSweeper, type Sweeper } from './loop.js';
import type { ResolvePlayer } from './notify.js';
import { registerRoutes } from './routes.js';

const SERVICE = 'matchmaker';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);

const redis = createRedis(config.REDIS_URL);
const db = createDb(config.DATABASE_URL);
registerClaimScript(redis);

const resolvePlayer: ResolvePlayer = async (playerId) => {
  const row = await getPlayer(db.db, playerId);
  return row ? { playerId: row.playerId, username: row.username, rating: row.rating } : undefined;
};

let sweeper: Sweeper | undefined;

app.addHook('onClose', async () => {
  await sweeper?.stop();
  await db.close();
  redis.disconnect();
});

installGracefulShutdown(app, app.log);

await registerRoutes(app, { redis, db: db.db });

app
  .listen({ port: config.MATCHMAKER_PORT, host: '0.0.0.0' })
  .then((addr) => {
    sweeper = startSweeper({ redis, db: db.db, resolvePlayer }, 100, (err) =>
      app.log.error({ err }, 'sweeper tick failed'),
    );
    app.log.info({ addr }, `${SERVICE} listening`);
  })
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
