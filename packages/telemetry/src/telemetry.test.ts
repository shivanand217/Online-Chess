// Smoke tests over the Fastify observability plugin. No Testcontainers needed — everything's in-process.
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGenReqId,
  httpRequests,
  installGracefulShutdown,
  registerObservability,
  registry,
} from './index.js';

async function makeApp(opts: { ready?: () => boolean | Promise<boolean> } = {}) {
  const app = Fastify({ logger: false, genReqId: createGenReqId() });
  registerObservability(app, { service: 'test', ...opts });
  app.get('/hello', async () => ({ ok: true }));
  app.get<{ Params: { id: string } }>('/items/:id', async (_req) => ({ ok: true }));
  return app;
}

afterEach(() => {
  // Reset counters so one test's traffic doesn't leak into the next.
  registry.resetMetrics();
});

describe('observability plugin', () => {
  it('/healthz is 200 and /readyz respects the probe', async () => {
    const app = await makeApp({ ready: () => false });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
  });

  it('/readyz is 200 when the probe returns true (or is absent)', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await app.close();
  });

  it('/metrics renders Prometheus text and includes the RED counter', async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: '/hello' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('http_requests_total');
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/hello"[^}]*\} 1/);
    expect(body).toContain('http_request_duration_seconds_bucket');
    await app.close();
  });

  it('labels the route by match pattern, not the raw URL (bounded cardinality)', async () => {
    const app = await makeApp();
    for (const id of ['a', 'b', 'c']) {
      await app.inject({ method: 'GET', url: `/items/${id}` });
    }
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/route="\/items\/:id"[^}]*\} 3/);
    expect(metrics).not.toContain('route="/items/a"');
    await app.close();
  });

  it('observes the duration histogram once per response', async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: '/hello' });
    const value = await httpRequests.get();
    const sample = value.values.find((v) => v.labels.route === '/hello');
    expect(sample?.value).toBe(1);
    await app.close();
  });
});

describe('createGenReqId', () => {
  it('returns a different UUID each time', () => {
    const gen = createGenReqId();
    const ids = new Set([gen(), gen(), gen(), gen()]);
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stamps req.id onto the request so logs can correlate', async () => {
    const app = Fastify({ logger: false, genReqId: createGenReqId() });
    registerObservability(app, { service: 'test' });
    let seen: string | undefined;
    app.get('/ping', async (req) => {
      seen = req.id;
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/ping' });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});

describe('installGracefulShutdown', () => {
  it('is a no-op if invoked without a signal (sanity: no throw at install time)', async () => {
    const app = Fastify({ logger: false });
    expect(() => installGracefulShutdown(app, app.log)).not.toThrow();
    await app.close();
  });
});
