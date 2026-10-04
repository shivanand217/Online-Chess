// Observability primitives every service reuses: structured logger, UUID request IDs stamped into every
// log line, Fastify RED hooks that fan into the shared Prometheus registry, health/readiness/metrics
// endpoints, and signal-driven graceful shutdown.
import { randomUUID } from 'node:crypto';
import { pino, type Logger } from 'pino';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { httpRequestDuration, httpRequests, registry } from './metrics.js';

export type { Logger };
export * from './metrics.js';

/** Named structured logger for non-HTTP contexts (background workers, scripts). */
export function createLogger(name: string, level = 'info'): Logger {
  return pino({ name, level });
}

/** Pass to `Fastify({ genReqId })` so each inbound request gets a correlation UUID that Pino
 *  automatically stamps into every log line (via `req.id`). */
export const createGenReqId = () => (): string => randomUUID();

export interface ObservabilityOptions {
  /** Optional readiness probe; a false return (sync or async) makes /readyz respond 503. */
  ready?: () => boolean | Promise<boolean>;
  /** Service name used as the `service` metric label. Defaults to the logger's name. */
  service?: string;
}

export function registerObservability(app: FastifyInstance, opts: ObservabilityOptions = {}): void {
  const service =
    opts.service ??
    (app.log as unknown as { bindings?: () => { name?: string } }).bindings?.()?.name ??
    'unknown';

  // Request-level RED timer. We stash start time on the request so the response hook can read it.
  app.addHook('onRequest', async (req) => {
    (req as { _redStart?: bigint })._redStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as { _redStart?: bigint })._redStart;
    if (start === undefined) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    // routeOptions.url is the match pattern (e.g. '/games/:id'); fall back to the raw URL for 404s so
    // we never incr unbounded label cardinality on client-chosen paths.
    const route = req.routeOptions?.url ?? 'unknown';
    const labels = { method: req.method, route, status: String(reply.statusCode), service };
    httpRequests.inc(labels);
    httpRequestDuration.observe(labels, seconds);
  });

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
    reply.header('content-type', registry.contentType);
    return registry.metrics();
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
