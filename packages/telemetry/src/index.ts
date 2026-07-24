// Observability primitives every service reuses: structured logger, health/readiness/metrics endpoints,
// and signal-driven graceful shutdown. Prometheus/OpenTelemetry get wired here in Phase 5. Hand-written.
import { pino, type Logger } from 'pino';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export type { Logger };

/**
 * Create a named structured (JSON) logger for non-HTTP contexts (background workers, scripts).
 * Fastify services should instead pass `{ logger: { name, level } }` to the Fastify factory, which
 * builds an equivalent pino logger internally and exposes it as `app.log`.
 */
export function createLogger(name: string, level = 'info'): Logger {
  return pino({ name, level });
}

export interface ObservabilityOptions {
  /** Optional readiness check; when it returns false, /readyz responds 503. */
  ready?: () => boolean | Promise<boolean>;
}

/** Register /healthz (liveness), /readyz (readiness) and a placeholder /metrics on a Fastify app. */
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
    return '# Prometheus metrics are wired in Phase 5 (see docs/05-observability.md)\n';
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
