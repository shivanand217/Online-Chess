// Thin wrapper around etcd3 for service membership. Each service grants a lease on startup and PUTs its
// own entry; losing contact with etcd drops the lease and the entry disappears, so a crashed instance
// stops being routed to without any explicit deregistration call.
import { Etcd3, type Lease, type Watcher } from 'etcd3';

export interface RegistryClient {
  /** Register this process under `prefix/id` with `value` kept alive by a lease. */
  register: (prefix: string, id: string, value: string, ttlSeconds?: number) => Promise<void>;
  /** Snapshot of current members under `prefix` (id → value). */
  list: (prefix: string) => Promise<Map<string, string>>;
  /** Watch `prefix` and call `onChange` with a fresh snapshot on every put/delete under it. */
  watch: (prefix: string, onChange: (members: Map<string, string>) => void) => Promise<Watcher>;
  /** Release everything: revoke the lease (if any), close the watcher, shut the client down. */
  close: () => Promise<void>;
}

export interface RegistryOptions {
  /** Comma-separated host:port list (etcd3 convention). */
  hosts: string;
}

export function createRegistry(opts: RegistryOptions): RegistryClient {
  const client = new Etcd3({ hosts: opts.hosts.split(',').map((h) => h.trim()) });
  let lease: Lease | undefined;
  const watchers: Watcher[] = [];

  async function list(prefix: string): Promise<Map<string, string>> {
    const raw = await client.getAll().prefix(prefix).strings();
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(raw)) {
      map.set(key.slice(prefix.length), value);
    }
    return map;
  }

  return {
    async register(prefix, id, value, ttlSeconds = 10) {
      lease = client.lease(ttlSeconds, { autoKeepAlive: true });
      await lease.put(`${prefix}${id}`).value(value);
    },
    list,
    async watch(prefix, onChange) {
      const watcher = await client.watch().prefix(prefix).create();
      const push = async (): Promise<void> => onChange(await list(prefix));
      watcher.on('put', () => void push());
      watcher.on('delete', () => void push());
      await push();
      watchers.push(watcher);
      return watcher;
    },
    async close() {
      for (const w of watchers) await w.cancel().catch(() => undefined);
      if (lease) await lease.revoke().catch(() => undefined);
      client.close();
    },
  };
}
