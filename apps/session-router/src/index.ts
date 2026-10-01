// Session router: maps gameId to the game-server owning it, via a consistent-hash ring built from
// ephemeral etcd membership so both players land on the same server.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'session-router';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.SESSION_ROUTER_PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
