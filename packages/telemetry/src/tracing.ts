// OpenTelemetry tracing bootstrap. Each service calls `startTracing(name)` from its own small
// `src/tracing.ts` module, which the entrypoint pulls in via `node --import ./tracing.js …` so the
// SDK is live before any module it needs to patch (fastify, pg, ioredis, undici) is first imported.
import { trace, type Span } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let started = false;

export interface TracingOptions {
  service: string;
  version?: string;
  /** OTLP HTTP endpoint for traces. Defaults to the OTEL_EXPORTER_OTLP_ENDPOINT env var, then
   *  Tempo's dev-stack address. */
  endpoint?: string;
}

/** Boot the OTel SDK. Idempotent; a second call is a no-op. */
export function startTracing(opts: TracingOptions): void {
  if (started) return;
  started = true;

  const endpoint =
    opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.version ?? '0.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // The default fs instrumentation is spammy and rarely interesting; everything else stays on.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Flush pending spans on SIGTERM/SIGINT so a clean shutdown doesn't lose the tail of the trace.
  const shutdown = async (): Promise<void> => {
    try {
      await sdk.shutdown();
    } catch {
      // best effort
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

/** Pino mixin: stamps `trace_id` + `span_id` into every log line that falls inside an active span,
 *  giving Grafana the link from a log row back to its trace. */
export function pinoTraceMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Re-export the span handle for services that want to attach custom attributes/events. */
export type { Span };
export { trace } from '@opentelemetry/api';
