// Game Server entrypoint — the stateful heart of the platform. Phase 0: health/readiness/metrics only.
// Phase 3 adds the WebSocket layer, in-memory board/clocks, move validation, persist-before-broadcast,
// crash recovery via replay, generation fencing, and latency compensation. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'game-server';
const config = loadConfig();

const app = Fastify({ logger: { name: SERVICE, level: config.LOG_LEVEL } });
registerObservability(app);
installGracefulShutdown(app, app.log);

app
  .listen({ port: config.GAME_SERVER_PORT, host: '0.0.0.0' })
  .then((addr) => app.log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    app.log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
