// One shared Prometheus registry per process. Services and this package itself register metrics against
// it; `/metrics` renders the whole registry. Default Node metrics (event-loop lag, memory, GC) are added
// by `prom-client` out of the box.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export { Counter, Gauge, Histogram } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export interface CounterOptions {
  name: string;
  help: string;
  labelNames?: string[];
}

export interface HistogramOptions extends CounterOptions {
  /** Bucket upper bounds in the unit of observation (seconds, usually). */
  buckets?: number[];
}

export const counter = <L extends string = string>(opts: CounterOptions): Counter<L> =>
  new Counter<L>({
    name: opts.name,
    help: opts.help,
    labelNames: (opts.labelNames ?? []) as L[],
    registers: [registry],
  });

export const histogram = <L extends string = string>(opts: HistogramOptions): Histogram<L> =>
  new Histogram<L>({
    name: opts.name,
    help: opts.help,
    labelNames: (opts.labelNames ?? []) as L[],
    buckets: opts.buckets,
    registers: [registry],
  });

export const gauge = <L extends string = string>(opts: CounterOptions): Gauge<L> =>
  new Gauge<L>({
    name: opts.name,
    help: opts.help,
    labelNames: (opts.labelNames ?? []) as L[],
    registers: [registry],
  });

/** HTTP RED metrics shared by every Fastify service. Request latency buckets cover ~1ms–10s. */
export const httpRequests = counter<'method' | 'route' | 'status' | 'service'>({
  name: 'http_requests_total',
  help: 'Count of HTTP requests served',
  labelNames: ['method', 'route', 'status', 'service'],
});

export const httpRequestDuration = histogram<'method' | 'route' | 'status' | 'service'>({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status', 'service'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
