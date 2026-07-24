// API Gateway entrypoint. Phase 0: a Fastify server exposing only health/readiness/metrics.
// REST routes (matchmaking long-poll in Phase 2, leaderboard reads in Phase 4) are added later. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'gateway';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
