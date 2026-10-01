// Observability primitives every service reuses: structured logger, health/readiness/metrics endpoints,
// and signal-driven graceful shutdown. Prometheus/OpenTelemetry wiring lands here later.
import { pino, type Logger } from 'pino';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export type { Logger };

/** Named structured logger for non-HTTP contexts (background workers, scripts). */
export function createLogger(name: string, level = 'info'): Logger {
  return pino({ name, level });
}

export interface ObservabilityOptions {
  /** Optional readiness check; false → /readyz responds 503. */
  ready?: () => boolean | Promise<boolean>;
}

export function registerObservability(app: FastifyInstance, opts: ObservabilityOptions = {}): void {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const ready = opts.ready ? await opts.ready() : true;
    if (!ready) {
      reply.code(503);
      return { status: 'not_ready' };
    }
    return { status: 'ready' };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return '# metrics not yet wired (see docs/05-observability.md)\n';
  });
}

/** Close the Fastify app cleanly on SIGTERM/SIGINT so rolling deploys drop no traffic. */
export function installGracefulShutdown(app: FastifyInstance, log: FastifyBaseLogger): void {
  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'graceful shutdown starting');
    try {
      await app.close();
      log.info('graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
