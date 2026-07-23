// Session Router entrypoint. Phase 0: health/readiness/metrics only.
// Phase 3 adds the consistent-hash ring built from etcd membership that pins both players to one game server. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createLogger, registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'session-router';
const config = loadConfig();
const log = createLogger(SERVICE, config.LOG_LEVEL);

const app = Fastify({ loggerInstance: log });
registerObservability(app);
installGracefulShutdown(app, log);

app
  .listen({ port: config.SESSION_ROUTER_PORT, host: '0.0.0.0' })
  .then((addr) => log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
