// Matchmaker worker entrypoint. Phase 0: health/readiness/metrics only.
// Phase 2 adds the Redis sorted-set pool, widening-window search, and the atomic ZREM claim. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createLogger, registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'matchmaker';
const config = loadConfig();
const log = createLogger(SERVICE, config.LOG_LEVEL);

const app = Fastify({ loggerInstance: log });
registerObservability(app);
installGracefulShutdown(app, log);

app
  .listen({ port: config.MATCHMAKER_PORT, host: '0.0.0.0' })
  .then((addr) => log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
