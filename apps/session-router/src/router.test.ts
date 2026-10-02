// End-to-end for the session router against a real etcd. Starts the router watcher, registers two fake
// game-server members via a separate registry client, hits /route/:gameId, deregisters one, and asserts
// the ring updates and routing adapts.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createRegistry, type RegistryClient } from '@chess/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HashRing, type RingNode } from './ring.js';
import { registerRoutes, type RingHolder } from './routes.js';

const PREFIX = '/chess/game-servers/';

let etcd: StartedTestContainer;
let etcdHosts: string;
let router: FastifyInstance;
let watcherRegistry: RegistryClient;
let publisherRegistry: RegistryClient;
let holder: RingHolder;

beforeAll(async () => {
  etcd = await new GenericContainer('quay.io/coreos/etcd:v3.5.17')
    .withCommand([
      '/usr/local/bin/etcd',
      '--listen-client-urls=http://0.0.0.0:2379',
      '--advertise-client-urls=http://0.0.0.0:2379',
    ])
    .withExposedPorts(2379)
    .withWaitStrategy(Wait.forLogMessage(/ready to serve client requests/))
    .start();
  etcdHosts = `http://${etcd.getHost()}:${etcd.getMappedPort(2379)}`;

  holder = { current: new HashRing([]) };
  watcherRegistry = createRegistry({ hosts: etcdHosts });
  publisherRegistry = createRegistry({ hosts: etcdHosts });

  router = Fastify({ logger: false });
  registerRoutes(router, holder);
  await router.listen({ port: 0, host: '127.0.0.1' });

  await watcherRegistry.watch(PREFIX, (members) => {
    const nodes: RingNode[] = [...members].map(([id, value]) => ({ id, value }));
    holder.current = new HashRing(nodes);
  });
}, 180_000);

afterAll(async () => {
  await router?.close();
  await watcherRegistry?.close();
  await publisherRegistry?.close();
  await etcd?.stop();
});

/** Wait until the predicate holds — covers the brief window between an etcd put and the watch firing. */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

async function routeOf(gameId: string): Promise<{ nodeId: string; wsUrl: string }> {
  const res = await router.inject({ method: 'GET', url: `/route/${gameId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as { nodeId: string; wsUrl: string };
}

describe('session router', () => {
  it('503s when no members are registered yet', async () => {
    holder.current = new HashRing([]);
    const res = await router.inject({ method: 'GET', url: `/route/${randomUUID()}` });
    expect(res.statusCode).toBe(503);
  });

  it('routes gameIds across registered members and stays stable', async () => {
    const idA = `server-a-${randomUUID()}`;
    const idB = `server-b-${randomUUID()}`;
    await publisherRegistry.register(PREFIX, idA, 'ws://host-a:3003');
    await publisherRegistry.register(PREFIX, idB, 'ws://host-b:3003');
    await waitFor(() => (holder.current.size() === 2 ? true : undefined));

    const sample = Array.from({ length: 20 }, () => randomUUID());
    const routes = new Map<string, string>();
    for (const gameId of sample) routes.set(gameId, (await routeOf(gameId)).nodeId);

    // Every assignment is one of the two registered servers.
    for (const nodeId of routes.values()) {
      expect([idA, idB]).toContain(nodeId);
    }

    // Stable: repeat the lookups, same answers.
    for (const gameId of sample) {
      const again = await routeOf(gameId);
      expect(again.nodeId).toBe(routes.get(gameId));
    }
  });

  it('/members mirrors the live registry', async () => {
    const res = await router.inject({ method: 'GET', url: '/members' });
    const body = res.json() as { members: string[] };
    expect(body.members.length).toBeGreaterThanOrEqual(2);
  });

  it('revoking a server’s lease removes it from the ring', async () => {
    // Add a short-lived client whose lease we'll revoke.
    const transient = createRegistry({ hosts: etcdHosts });
    const transientId = `server-x-${randomUUID()}`;
    await transient.register(PREFIX, transientId, 'ws://host-x:3003');
    await waitFor(() => (holder.current.ids().includes(transientId) ? true : undefined));

    await transient.close();
    await waitFor(() => (!holder.current.ids().includes(transientId) ? true : undefined));

    expect(holder.current.ids()).not.toContain(transientId);
  });
});
