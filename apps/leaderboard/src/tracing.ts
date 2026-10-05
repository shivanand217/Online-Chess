// OTel bootstrap — loaded via `node --import ./tracing.js …` so the SDK is live before any module it
// patches (fastify, pg, ioredis, undici) is first imported.
import { startTracing } from '@chess/telemetry';
startTracing({ service: 'leaderboard' });
