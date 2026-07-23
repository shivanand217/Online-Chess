// API Gateway entrypoint. Phase 0: a Fastify server exposing only health/readiness/metrics.
// REST routes (matchmaking long-poll in Phase 2, leaderboard reads in Phase 4) are added later. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createLogger, registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'gateway';
const config = loadConfig();
const log = createLogger(SERVICE, config.LOG_LEVEL);

const app = Fastify({ loggerInstance: log });
registerObservability(app);
installGracefulShutdown(app, log);

app
  .listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' })
  .then((addr) => log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
