// Matchmaker worker entrypoint. Phase 0: health/readiness/metrics only.
// Phase 2 adds the Redis sorted-set pool, widening-window search, and the atomic ZREM claim. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'matchmaker';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.MATCHMAKER_PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
