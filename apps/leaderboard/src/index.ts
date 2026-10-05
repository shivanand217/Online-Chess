// Leaderboard: idempotent ELO apply on game end + rank/top-N reads over a Redis sorted set.
// The service runs the sweeper on an interval and serves two read endpoints.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createDb } from '@chess/db';
import { createRedis } from '@chess/redis';
import {
  createGenReqId,
  installGracefulShutdown,
  registerObservability,
  pinoTraceMixin,
} from '@chess/telemetry';
import { reconcile } from './reconcile.js';
import { registerRoutes } from './routes.js';
import { startSweeper, type Sweeper } from './sweeper.js';

const SERVICE = 'leaderboard';
const config = loadConfig();

const app = Fastify({
  logger: { name: SERVICE, level: config.LOG_LEVEL, mixin: pinoTraceMixin },
  genReqId: createGenReqId(),
});

const db = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

registerObservability(app, {
  ready: async () => {
    try {
      await db.pool.query('SELECT 1');
      await redis.ping();
      return true;
    } catch {
      return false;
    }
  },
});

let sweeper: Sweeper | undefined;

app.addHook('onClose', async () => {
  await sweeper?.stop();
  await db.close();
  redis.disconnect();
});
installGracefulShutdown(app, app.log);

registerRoutes(app, { db: db.db, redis });

// Admin endpoint: full rebuild of the sorted set from Postgres truth. Guarded on an env flag in a real
// deploy; dev-only for now.
app.post('/admin/reconcile', async () => reconcile(db.db, redis));

app
  .listen({ port: config.LEADERBOARD_PORT, host: '0.0.0.0' })
  .then((addr) => {
    sweeper = startSweeper({ db: db.db, redis }, 500, (err) =>
      app.log.error({ err }, 'sweeper tick failed'),
    );
    app.log.info({ addr }, `${SERVICE} listening`);
  })
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
