// Game Server entrypoint — the stateful heart of the platform. Phase 0: health/readiness/metrics only.
// Phase 3 adds the WebSocket layer, in-memory board/clocks, move validation, persist-before-broadcast,
// crash recovery via replay, generation fencing, and latency compensation. Hand-written.
import Fastify from 'fastify';
import { loadConfig } from '@chess/config';
import { createLogger, registerObservability, installGracefulShutdown } from '@chess/telemetry';

const SERVICE = 'game-server';
const config = loadConfig();
const log = createLogger(SERVICE, config.LOG_LEVEL);

const app = Fastify({ loggerInstance: log });
registerObservability(app);
installGracefulShutdown(app, log);

app
  .listen({ port: config.GAME_SERVER_PORT, host: '0.0.0.0' })
  .then((addr) => log.info({ addr }, `${SERVICE} listening`))
  .catch((err) => {
    log.error({ err }, `${SERVICE} failed to start`);
    process.exit(1);
  });
